import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Request } from 'express';
import { Repository } from 'typeorm';
import { Employee } from '../employee/employee.entity';
import { AuthUser } from '../type/auth-user.type';
import { Policy } from './entities/policy.entity';
import { PolicyContractArchiveService } from './policy-contract-archive.service';
import { resolvePolicyScope } from './policy-scope';

const CONTRACT_PREFIX = '/uploads/policy-contracts/';

/** Quyền đọc file hợp đồng phải giống đúng phạm vi xem policy chứa file đó. */
@Injectable()
export class PolicyContractAccessService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Policy)
    private readonly policyRepo: Repository<Policy>,
  ) {}

  /** Dùng cho middleware đứng trước express.static, nơi JwtAuthGuard không chạy. */
  async authenticateAndAssert(req: Request, name: string): Promise<AuthUser> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const secret = this.config.get<string>('JWT_SECRET');
    if (!token || !secret) throw new UnauthorizedException('Cần đăng nhập');

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret,
      });
    } catch {
      throw new UnauthorizedException('Token không hợp lệ hoặc đã hết hạn');
    }

    const id = Number(payload.sub);
    const employee = Number.isInteger(id)
      ? await this.employeeRepo.findOne({
          where: { id },
          select: ['id', 'name', 'roles', 'isActive'],
        })
      : null;
    if (!employee || employee.isActive === false) {
      throw new UnauthorizedException('Tài khoản không còn hoạt động');
    }

    const user: AuthUser = {
      id: Number(employee.id),
      name: employee.name,
      roles: employee.roles ?? [],
    };
    await this.assertCanRead(user, name);
    return user;
  }

  async assertCanRead(user: AuthUser | undefined, name: string): Promise<void> {
    if (!PolicyContractArchiveService.isValidName(name)) {
      throw new NotFoundException('Không tìm thấy file');
    }

    const scope = resolvePolicyScope(user);
    const url = `${CONTRACT_PREFIX}${name}`;
    const qb = this.policyRepo
      .createQueryBuilder('policy')
      .innerJoin('policy.subject', 'subject')
      .innerJoin('subject.school', 'school')
      .leftJoin('school.ward', 'ward')
      .where(
        `(
          policy.contract_file_url = :url
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(policy.contract_files, '[]'::jsonb)) AS file
            WHERE file->>'url' = :url
          )
        )`,
        { url },
      );

    if (scope.kind === 'province') {
      qb.andWhere('ward.province_id = :provinceId', {
        provinceId: scope.provinceId,
      });
    } else if (scope.kind === 'own') {
      qb.andWhere('school.employee_id = :employeeId', {
        employeeId: scope.employeeId,
      });
    }

    const allowed = await qb.select('policy.id').getOne();
    if (!allowed) {
      // 403 cho tài khoản đã xác thực nhưng file nằm ngoài phạm vi. Không trả
      // metadata policy/file trong lỗi.
      throw new ForbiddenException('Bạn không có quyền xem tài liệu này');
    }
  }
}
