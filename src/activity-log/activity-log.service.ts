import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ActivityLog } from './activity-log.entity';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';

@Injectable()
export class ActivityLogService {
  private readonly logger = new Logger(ActivityLogService.name);

  constructor(
    @InjectRepository(ActivityLog)
    private readonly repo: Repository<ActivityLog>,
  ) {}

  /**
   * Ghi log **không bao giờ** được làm hỏng request nghiệp vụ: nuốt lỗi và chỉ
   * cảnh báo, vì mất một dòng nhật ký nhẹ hơn việc giáo vụ không lưu được lịch.
   */
  async record(entry: Partial<ActivityLog>): Promise<void> {
    try {
      await this.repo.insert(this.repo.create(entry));
    } catch (err) {
      this.logger.warn(`Không ghi được nhật ký thao tác: ${err?.message}`);
    }
  }

  async find(dto: QueryActivityLogDto) {
    const page = dto.page && dto.page > 0 ? dto.page : 1;
    const limit = dto.limit && dto.limit > 0 ? Math.min(dto.limit, 200) : 50;

    const qb = this.repo.createQueryBuilder('log');

    if (dto.actorId) qb.andWhere('log.actorId = :actorId', { actorId: dto.actorId });
    if (dto.resource) qb.andWhere('log.resource = :resource', { resource: dto.resource });
    if (dto.method)
      qb.andWhere('log.method = :method', { method: dto.method.toUpperCase() });
    if (dto.success !== undefined)
      qb.andWhere('log.success = :success', { success: dto.success });

    if (dto.fromDate || dto.toDate) {
      qb.andWhere('log.createdAt BETWEEN :from AND :to', {
        from: dto.fromDate ? new Date(`${dto.fromDate}T00:00:00`) : new Date(0),
        to: dto.toDate
          ? new Date(`${dto.toDate}T23:59:59.999`)
          : new Date(8.64e15),
      });
    }

    // Lọc theo id chứ không theo tên: trường đổi tên hay hai giáo viên trùng
    // tên thì lọc theo tên vừa sót vừa thừa. Interceptor gom sẵn mọi id chạm
    // tới vào `context.schoolIds` / `teacherIds`, kể cả thao tác hàng loạt.
    this.filterByContextId(qb, 'schoolIds', 'schoolId', dto.schoolId);
    this.filterByContextId(qb, 'teacherIds', 'teacherId', dto.teacherId);

    const [data, total] = await qb
      .orderBy('log.createdAt', 'DESC')
      .addOrderBy('log.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * `context.schoolIds @> [448]`. Vẫn xét cả field số ít cho log của các bản
   * ghi chỉ chạm đúng một trường — hai field cùng được ghi nên điều kiện nào
   * khớp cũng đủ.
   */
  private filterByContextId(
    qb: SelectQueryBuilder<ActivityLog>,
    arrayField: string,
    scalarField: string,
    id?: number,
  ) {
    if (!id) return;

    // Tên field là hằng trong mã nguồn, không phải đầu vào — nội suy thẳng để
    // khỏi phải truyền tên khoá jsonb qua tham số.
    qb.andWhere(
      `(log.context -> '${arrayField}' @> :${arrayField}::jsonb
        OR (log.context ->> '${scalarField}') = :${scalarField})`,
      { [arrayField]: JSON.stringify([id]), [scalarField]: String(id) },
    );
  }

  /** Lịch sử thao tác trên một bản ghi cụ thể, vd `teachers/12`. */
  async findByResource(resource: string, resourceId: string) {
    return this.repo
      .createQueryBuilder('log')
      .where('log.resource = :resource', { resource })
      .andWhere('log.path LIKE :prefix', { prefix: `/${resource}/${resourceId}%` })
      .orderBy('log.createdAt', 'DESC')
      .getMany();
  }

  async actors() {
    const rows = await this.repo
      .createQueryBuilder('log')
      .select('log.actorId', 'actorId')
      .addSelect('MAX(log.actorName)', 'actorName')
      .addSelect('COUNT(*)', 'total')
      .groupBy('log.actorId')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany();

    return rows.map((r) => ({
      actorId: Number(r.actorId),
      actorName: r.actorName,
      total: Number(r.total),
    }));
  }
}
