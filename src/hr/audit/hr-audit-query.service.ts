import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HR_TIME_ZONE } from '../common/effective-date';
import { UNRESTRICTED_SCOPES } from '../access/hr-permission';
import type { HrGrant } from '../access/hr-access.service';
import { QueryHrAuditLogDto } from './dto/query-hr-audit-log.dto';
import { HrAuditLog } from './entities/hr-audit-log.entity';

@Injectable()
export class HrAuditQueryService {
  constructor(
    @InjectRepository(HrAuditLog)
    private readonly logs: Repository<HrAuditLog>,
  ) {}

  /**
   * `grants` là quyền AUDIT_VIEW guard đã nạp cho người gọi. Chỉ phạm vi
   * COMPANY/ALL được đọc: audit của một nhóm người đòi lọc theo dữ liệu tổ
   * chức chưa có (Phase 1), nên phạm vi hẹp hơn bị từ chối thay vì lộ hết.
   */
  async list(grants: HrGrant[], query: QueryHrAuditLogDto) {
    if (!grants.some((g) => UNRESTRICTED_SCOPES.includes(g.scope))) {
      throw new ForbiddenException(
        'Chỉ phạm vi toàn công ty mới xem được nhật ký audit HR',
      );
    }
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException('from phải trước hoặc bằng to');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.logs.createQueryBuilder('a');
    if (query.entity)
      qb.andWhere('a.entity = :entity', { entity: query.entity });
    if (query.entityId)
      qb.andWhere('a.entityId = :entityId', { entityId: query.entityId });
    if (query.actorAccountId)
      qb.andWhere('a.actorAccountId = :actor', { actor: query.actorAccountId });
    if (query.action)
      qb.andWhere('a.action = :action', { action: query.action });
    // Mốc ngày tính theo giờ Việt Nam, không theo giờ server.
    if (query.from)
      qb.andWhere(
        `a.occurredAt >= (CAST(:from AS date)::timestamp AT TIME ZONE :tz)`,
        { from: query.from, tz: HR_TIME_ZONE },
      );
    if (query.to)
      qb.andWhere(
        `a.occurredAt < ((CAST(:to AS date) + 1)::timestamp AT TIME ZONE :tz)`,
        { to: query.to, tz: HR_TIME_ZONE },
      );

    const [items, total] = await qb
      .orderBy('a.occurredAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { items, total, page, limit };
  }
}
