import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Employee } from './employee.entity';
import { QueryFailedError, Repository } from 'typeorm';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import * as bcrypt from 'bcrypt';
import { ChangePasswordDto } from './dto/changepassword.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { EmployeeFace } from './employee-face.entity';
import { AvatarStorageService } from '../teaching/avatar-storage.service';
import { assertNoTeacherRoleGrant, DEV_ROLE } from './employee-roles';
import { AuthUser } from '../type/auth-user.type';

/**
 * Bỏ mật khẩu băm khỏi dữ liệu trả về. Các endpoint đọc ở đây trả nguyên
 * entity, mà băm lọt ra ngoài là mở đường dò mật khẩu offline.
 */
function stripPassword<T extends { password?: string | null }>(row: T): T;
function stripPassword<T extends { password?: string | null }>(rows: T[]): T[];
function stripPassword(input: any): any {
  if (Array.isArray(input)) return input.map((row) => stripPassword(row));
  if (!input || typeof input !== 'object') return input;

  const { password: _password, ...rest } = input;
  return rest;
}

@Injectable()
export class EmployeeService {
  constructor(
    @InjectRepository(Employee)
    private repo: Repository<Employee>,
    @InjectRepository(EmployeeFace)
    private readonly employeeFaceRepository: Repository<EmployeeFace>,
    private readonly avatarStorage: AvatarStorageService,
  ) {}
  async create(data: CreateEmployeeDto) {
    const existedEmail = await this.repo.findOne({
      where: {
        email: data.email,
      },
    });

    if (existedEmail) {
      throw new ConflictException('Email đã được sử dụng');
    }

    const existedPhone = await this.repo.findOne({
      where: {
        phone: data.phone,
      },
    });

    if (existedPhone) {
      throw new ConflictException('Số điện thoại đã được sử dụng');
    }

    const roles = data.roles ?? (data.role ? [data.role] : ['sales']);
    assertNoTeacherRoleGrant(roles);

    let hashedPassword: string | undefined;

    if (data.password) {
      hashedPassword = await bcrypt.hash(data.password, 10);
    }

    const employee = this.repo.create({
      name: data.name,

      email: data.email,

      phone: data.phone,

      password: hashedPassword,

      roles,

      department: data.departmentId
        ? {
            id: data.departmentId,
          }
        : undefined,
    });

    try {
      return stripPassword(await this.repo.save(employee));
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as any).code === '23505'
      ) {
        const detail = String((error as any).detail || '');
        if (detail.includes('(phone)')) {
          throw new ConflictException('Số điện thoại đã được sử dụng');
        }
        if (detail.includes('(email)')) {
          throw new ConflictException('Email đã được sử dụng');
        }
      }
      throw error;
    }
  }
  findAll(user: AuthUser) {
    const query = this.repo
      .createQueryBuilder('employee')
      .select([
        'employee.id',
        'employee.name',
        'employee.email',
        'employee.phone',
        'employee.roles',
      ]);

    // role bị giới hạn tỉnh
    if (
      user.roles?.includes('salesadmin_la') ||
      user.roles?.includes('director_la')
    ) {
      query
        .innerJoin('employee.employeeRegions', 'employeeRegion')
        .andWhere('employeeRegion.province_id = :provinceId', {
          provinceId: 7,
        });
    }

    return query.getMany();
  }

  findSalesEmployees(user: AuthUser) {
    const query = this.repo
      .createQueryBuilder('employee')
      .select([
        'employee.id',
        'employee.name',
        'employee.email',
        'employee.phone',
        'employee.roles',
      ])
      .where(':salesRole = ANY(employee.roles)', {
        salesRole: 'sales',
      })
      .andWhere('employee.isActive = :isActive', {
        isActive: true,
      });

    if (
      user.roles?.includes('salesadmin_la') ||
      user.roles?.includes('director_la')
    ) {
      query
        .innerJoin('employee.employeeRegions', 'employeeRegion')
        .andWhere('employeeRegion.province_id = :provinceId', {
          provinceId: 7,
        });
    }

    return query.orderBy('employee.name', 'ASC').getMany();
  }

  async findByPhone(phone: string) {
    return this.repo.findOne({
      where: { phone },
    });
  }

  async saveTeacherZaloIdentifiers(
    employeeId: number,
    identifiers: { uid?: string; zaloId?: string },
  ): Promise<void> {
    const uid = identifiers.uid?.trim();
    const zaloId = identifiers.zaloId?.trim();
    if (!uid && !zaloId) return;

    try {
      await this.repo.update(employeeId, {
        ...(uid ? { zaloUid: uid } : {}),
        ...(zaloId ? { zaloUserId: zaloId } : {}),
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as any).code === '23505'
      ) {
        throw new ConflictException(
          'Tài khoản Zalo này đã được liên kết với một giáo viên khác',
        );
      }
      throw error;
    }
  }
  /**
   * Hồ sơ rút gọn cho trang cá nhân (`GET /employees/getbyid/:id`). Chọn
   * tường minh từng cột để không lộ password; thêm cột mới hiển thị ở trang
   * cá nhân là phải thêm vào đây — từng quên `avatarUrl` khiến avatar mất
   * sau khi reload trang.
   */
  findOne(id: number) {
    return this.repo.findOne({
      where: { id },
      select: ['id', 'name', 'email', 'phone', 'avatarUrl', 'roles', 'isActive'],
    });
  }

  remove(id: number) {
    return this.repo.delete(id);
  }

  async findByDepartment(departmentId: number) {
    return stripPassword(
      await this.repo.find({
        where: {
          department: {
            id: departmentId,
          },
        },
        relations: ['department'],
      }),
    );
  }

  async getByDepartmentAndRegion(departmentId: number, regionId: number) {
    return stripPassword(
      await this.repo
        .createQueryBuilder('employee')
        .innerJoinAndSelect('employee.department', 'department')
        .innerJoinAndSelect('employee.employeeRegions', 'er')
        .innerJoinAndSelect('er.region', 'region')
        .where('department.id = :departmentId', { departmentId })
        .andWhere('region.id = :regionId', { regionId })
        .getMany(),
    );
  }

  async addFace(employeeId: number, descriptor: number[]) {
    const employee = await this.repo.findOneBy({
      id: employeeId,
    });

    if (!employee) {
      throw new Error('Employee not found');
    }

    // normalize
    const magnitude = Math.sqrt(
      descriptor.reduce((sum, val) => sum + val * val, 0),
    );

    const normalized = descriptor.map((v) => v / magnitude);

    // save employee_face
    const face = this.employeeFaceRepository.create({
      employeeId,

      descriptor: normalized,

      qualityScore: 1,

      isActive: true,
    });

    return this.employeeFaceRepository.save(face);
  }
  async findAllWithFaceDescriptors(): Promise<Employee[]> {
    return this.repo
      .createQueryBuilder('e')
      .where('e.faceDescriptors IS NOT NULL')
      .getMany();
  }
  async findById(id: number) {
    const emp = await this.repo.findOne({
      where: { id },
      // Không nạp `notifications` / `dailyReports`: một nhân viên Nhân sự có
      // hàng nghìn thông báo, kéo hết vào GET hồ sơ là vô ích và chậm — FE
      // không đọc hai field này (đã rà toàn bộ kido-app).
      relations: ['department', 'schools', 'employeeRegions'],
    });

    if (!emp) {
      throw new NotFoundException('Employee not found');
    }

    return stripPassword(emp);
  }
  /**
   * Tài khoản dev tự đổi role cho chính mình — chỉ hoạt động nếu tài khoản
   * ĐANG đã có role `dev` (kiểm tra lại trên chính bản ghi DB, không chỉ tin
   * theo JWT — token cũ có thể còn role dev dù DB đã bị gỡ). Luôn giữ lại
   * role `dev` trong mảng để tài khoản không tự khoá mất khả năng đổi role
   * của chính mình.
   */
  async setDevRoles(userId: number, roles: string[]) {
    const emp = await this.repo.findOne({ where: { id: userId } });
    if (!emp) {
      throw new NotFoundException('Employee not found');
    }
    if (!emp.roles?.includes(DEV_ROLE)) {
      throw new ForbiddenException(
        'Chỉ tài khoản có role dev mới tự đổi role được',
      );
    }

    emp.roles = [...new Set([...roles, DEV_ROLE])];
    await this.repo.save(emp);

    return stripPassword(emp);
  }

  async changePassword(employeeId: number, dto: ChangePasswordDto) {
    const user = await this.repo.findOne({
      where: { id: employeeId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (!user.password) {
      throw new BadRequestException('User chưa có mật khẩu');
    }

    const isMatch = await bcrypt.compare(dto.oldPassword, user.password);

    if (!isMatch) {
      throw new BadRequestException('Mật khẩu hiện tại không đúng');
    }

    if (dto.oldPassword === dto.newPassword) {
      throw new BadRequestException('Mật khẩu mới phải khác mật khẩu hiện tại');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);

    user.password = hashedPassword;

    await this.repo.save(user);

    return { message: 'Password changed successfully' };
  }
  async update(
    id: number,
    dto: UpdateEmployeeDto,
    avatar?: Express.Multer.File,
  ) {
    const current = await this.repo.findOne({ where: { id } });
    if (!current) {
      throw new NotFoundException('Employee not found');
    }

    const { password, departmentId, ...rest } = dto;

    // Lưu ảnh trước, ngoài transaction: xử lý ảnh (sharp) chậm, không giữ
    // khoá bảng trong lúc đó. Ghi DB hỏng thì xoá ảnh vừa lưu.
    const newAvatarUrl = avatar ? await this.avatarStorage.store(avatar) : null;

    const patch: Partial<Employee> = {
      ...rest,
      ...(password ? { password: await bcrypt.hash(password, 10) } : {}),
      ...(departmentId ? { department: { id: departmentId } as never } : {}),
      ...(newAvatarUrl ? { avatarUrl: newAvatarUrl } : {}),
    };

    // ValidationPipe({ transform: true }) trả về instance của DTO, nên field
    // optional không gửi vẫn là own-property `undefined`. TypeORM bỏ qua
    // undefined khi build SET — body rỗng thành UPDATE không có SET và nổ
    // UpdateValuesMissingError. Lọc trước, rỗng thì trả hồ sơ hiện tại.
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (patch[key] === undefined) delete patch[key];
    }

    if (Object.keys(patch).length > 0) {
      try {
        await this.repo.update(id, patch);
      } catch (error) {
        await this.avatarStorage.remove(newAvatarUrl);
        throw error;
      }
    }

    // Đã ghi xong mới dọn ảnh cũ — xoá trước mà ghi hỏng là mất ảnh.
    if (newAvatarUrl && current.avatarUrl !== newAvatarUrl) {
      await this.avatarStorage.remove(current.avatarUrl);
    }

    const updated = await this.repo.findOne({ where: { id } });
    if (!updated) {
      throw new NotFoundException('Employee not found');
    }

    return stripPassword(updated);
  }
}
