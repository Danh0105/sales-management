import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Observable, from, switchMap, tap } from 'rxjs';

import { AuthUser } from '../type/auth-user.type';
import { ACADEMIC_ROLE, HR_ROLE } from '../teaching/teaching-roles';
import { ActivityLogService } from './activity-log.service';
import {
  AUDITED_ENTITIES,
  AUDITED_BULK_CREATES,
  AUDITED_SUBCOLLECTIONS,
  DIFF_IGNORED_FIELDS,
  ROW_IGNORED_FIELDS,
  ID_FIELD_LOOKUPS,
  LOOKUP_PATH_SUFFIXES,
  SKIPPED_RESOURCES,
  SNAPSHOT_RELATIONS,
} from './audited-entities';
import {
  capPayload,
  collectIds,
  describeFiles,
  diffSnapshots,
  flattenRelationNames,
  extractContext,
  pickFields,
  resourceOf,
  sanitizeBody,
  stripRowFields,
} from './activity-log.util';

/** Hai bộ phận cần lưu vết thao tác. */
export const AUDITED_ROLES = [ACADEMIC_ROLE, HR_ROLE];

const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];

/** Chỉ các method sửa/xoá mới có "dữ liệu cũ" để chụp. */
const SNAPSHOT_METHODS = ['PATCH', 'PUT', 'DELETE'];

/**
 * Ghi nhật ký **mọi** request ghi dữ liệu do Giáo vụ / Nhân sự thực hiện.
 *
 * Cố ý làm ở tầng interceptor toàn cục thay vì gọi rải rác trong từng service:
 * hai role này đụng tới hàng chục endpoint ở nhiều module, và một endpoint mới
 * thêm sau này sẽ tự động được ghi log mà không ai phải nhớ.
 *
 * Chỉ ghi request **ghi** dữ liệu — log cả GET thì mỗi lần mở màn hình danh
 * sách lại đẻ ra vài chục dòng và nhật ký thành vô dụng.
 */
@Injectable()
export class ActivityLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ActivityLogInterceptor.name);

  constructor(
    private readonly service: ActivityLogService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest();
    const user: AuthUser | undefined = req?.user;

    if (!user?.id || !this.shouldAudit(req, user)) return next.handle();

    // Chụp lại body ngay lúc này: pipe/service phía sau có thể sửa đổi nó.
    const snapshot = this.snapshot(req, user);
    const startedAt = Date.now();

    // Phải đọc bản ghi **trước** khi handler chạy, nếu không thì đọc ra bản đã sửa.
    return from(this.loadRow(req)).pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap({
            next: (data) => {
              void this.finish(req, snapshot, before, data, {
                success: true,
                statusCode: http.getResponse()?.statusCode ?? 200,
                durationMs: Date.now() - startedAt,
              });
            },
            error: (err) => {
              void this.service.record({
                ...snapshot,
                // Thao tác hỏng thì dữ liệu không đổi — chỉ ghi bản ghi lúc đó.
                beforeData: capPayload(before),
                success: false,
                statusCode: err?.status ?? err?.statusCode ?? 500,
                errorMessage: String(err?.message ?? err).slice(0, 1000),
                durationMs: Date.now() - startedAt,
              });
            },
          }),
        ),
      ),
    );
  }

  private async finish(
    req: any,
    snapshot: Record<string, any>,
    before: Record<string, any> | null,
    data: any,
    outcome: Record<string, any>,
  ) {
    // Đọc lại sau khi lưu thay vì tin vào response: nhiều endpoint chỉ trả
    // `{ success: true }` hoặc một DTO rút gọn, so với nó thì ra diff sai.
    const after =
      (await this.loadCreatedRows(req, data)) ??
      (req.method === 'DELETE' ? null : await this.loadRow(req));
    const changes = diffSnapshots(before, after, DIFF_IGNORED_FIELDS);
    const context = await this.buildContext(data, req.body, after ?? before);

    void this.service.record({
      ...snapshot,
      context,
      beforeData: capPayload(before),
      afterData: capPayload(after),
      changes: capPayload(changes.length ? changes : null),
      ...outcome,
    });
  }

  /**
   * Bối cảnh: lấy từ response/bản ghi trước, thiếu tên nào thì tra nốt theo id
   * trong body. Endpoint tạo mới chỉ gửi `schoolId: 448` mà không kèm quan hệ,
   * không tra thì nhật ký hiện đúng con số đó và người đọc chịu.
   */
  private async buildContext(
    data: any,
    body: any,
    row: Record<string, any> | null,
  ) {
    const ctx: Record<string, any> = {
      ...(extractContext(row, null) ?? {}),
      ...(extractContext(data, body) ?? {}),
    };

    const source = { ...(row ?? {}), ...(body ?? {}) };

    // Id để lọc: lấy từ cả bản chụp lẫn payload, gom cả trong mảng — một lô
    // lịch dạy chạm tới nhiều trường và phải lọc ra được đủ.
    for (const [field, key] of [
      ['schoolId', 'school'],
      ['teacherId', 'teacher'],
    ] as const) {
      const ids = collectIds(source, field);
      if (!ids.length) continue;
      ctx[`${key}Ids`] = ids;
      if (ids.length === 1) ctx[field] = ids[0];
    }

    for (const lookup of ID_FIELD_LOOKUPS) {
      if (ctx[lookup.context]) continue;

      const id = Number(source[lookup.field]);
      if (!Number.isInteger(id) || id <= 0) continue;

      const name = await this.lookupName(lookup.entity, id);
      if (name) ctx[lookup.context] = name;
    }

    return Object.keys(ctx).length ? ctx : null;
  }

  private async lookupName(
    resource: keyof typeof AUDITED_ENTITIES,
    id: number,
  ): Promise<string | null> {
    try {
      const row: any = await this.dataSource
        .getRepository(AUDITED_ENTITIES[resource])
        .findOne({ where: { id } as any, loadEagerRelations: false });
      return typeof row?.name === 'string' ? row.name : null;
    } catch {
      // Bảng lạ hoặc bản ghi vừa bị xoá — thiếu tên còn hơn hỏng request.
      return null;
    }
  }

  /**
   * Bản chụp phẳng của bản ghi đang bị tác động, tra theo id trong path.
   *
   * Không lấy quan hệ: quan hệ đã nằm ở `context`, kéo thêm vào đây chỉ làm
   * phình log và đẻ ra diff giả mỗi khi một bảng liên quan đổi.
   */
  private async loadRow(req: any): Promise<Record<string, any> | null> {
    if (!SNAPSHOT_METHODS.includes(req?.method)) return null;

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];

    // `/teachers/12/reset-password` → 12. Endpoint hàng loạt (không có id
    // trong path) thì bỏ qua: không có "một bản ghi" nào để so.
    const id = path.match(/\/(\d+)(?:\/|$)/)?.[1];
    if (!id) return null;

    // Bảng con phải xét trước: `/schools/365/periods` sửa bảng tiết chứ không
    // sửa trường, chụp bản ghi `schools` thì lúc nào cũng ra diff rỗng.
    const collection = await this.loadCollection(path, Number(id));
    if (collection) return collection;

    const resource = resourceOf(path);
    const entity = AUDITED_ENTITIES[resource];
    if (!entity) return null;

    // Nạp quan hệ với các bảng đã khai — bắt buộc với xoá lịch dạy, nơi bản ghi
    // trơ id là vô dụng vì sau khi xoá thì không tra ngược lại được nữa.
    const relations = SNAPSHOT_RELATIONS[resource];

    try {
      const row = await this.dataSource.getRepository(entity).findOne({
        where: { id: Number(id) } as any,
        loadEagerRelations: false,
        relations,
      });
      return row ? flattenRelationNames(sanitizeBody(row)) : null;
    } catch (err) {
      // Chụp hụt thì nhật ký thiếu phần so sánh, không được làm hỏng request.
      this.logger.warn(`Không chụp được dữ liệu cũ: ${err?.message}`);
      return null;
    }
  }

  /**
   * Chụp các bản ghi vừa được tạo bởi một endpoint tạo hàng loạt.
   *
   * Khác `loadRow`: ở đây không có id nào trong path, id chỉ xuất hiện trong
   * response — nên phải chạy **sau** handler. `null` nghĩa là endpoint này
   * không phải tạo hàng loạt, để phần chụp thường xử lý tiếp.
   */
  private async loadCreatedRows(
    req: any,
    data: any,
  ): Promise<Record<string, any> | null> {
    if (req?.method !== 'POST') return null;

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const suffix = path.split('/').filter(Boolean).pop();

    const config = AUDITED_BULK_CREATES.find(
      (c) => c.resource === resourceOf(path) && c.suffix === suffix,
    );
    if (!config) return null;

    const ids = config.idsOf(data);
    // Lô bị bỏ qua sạch (trùng lịch, lớp không tồn tại) — không tạo được gì thì
    // ghi mảng rỗng, khác hẳn với "endpoint này không chụp được".
    if (!ids.length) return { [config.key]: [] };

    try {
      const rows = await this.dataSource.getRepository(config.entity).find({
        where: { id: In(ids) } as any,
        loadEagerRelations: false,
        relations: config.relations,
      });

      return {
        [config.key]: rows.map((row) =>
          pickFields(flattenRelationNames(sanitizeBody(row)), config.fields),
        ),
      };
    } catch (err) {
      this.logger.warn(`Không chụp được lô vừa tạo: ${err?.message}`);
      return null;
    }
  }

  /**
   * Chụp cả danh sách bảng con của một bản ghi cha, dạng `{ periods: [...] }`
   * để `diffSnapshots` sinh ra đúng một field `periods` với mảng trước/sau —
   * đúng thứ màn hình nhật ký cần để dựng cột "Dữ liệu cũ / Dữ liệu mới".
   */
  private async loadCollection(
    path: string,
    parentId: number,
  ): Promise<Record<string, any> | null> {
    const segments = path.split('/').filter(Boolean);
    const suffix = segments[segments.length - 1];

    const config = AUDITED_SUBCOLLECTIONS.find(
      (c) => c.resource === resourceOf(path) && c.suffix === suffix,
    );
    if (!config) return null;

    try {
      const rows = await this.dataSource.getRepository(config.entity).find({
        where: { [config.parentField]: parentId } as any,
        order: config.order as any,
        loadEagerRelations: false,
      });
      return {
        [config.key]: stripRowFields(sanitizeBody(rows), ROW_IGNORED_FIELDS),
      };
    } catch (err) {
      this.logger.warn(`Không chụp được bảng con ${suffix}: ${err?.message}`);
      return null;
    }
  }

  private shouldAudit(req: any, user: AuthUser): boolean {
    if (!MUTATING_METHODS.includes(req?.method)) return false;

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (SKIPPED_RESOURCES.includes(resourceOf(path))) return false;
    if (LOOKUP_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))) return false;

    const roles = user.roles ?? (user.role ? [user.role] : []);
    return roles.some((r) => AUDITED_ROLES.includes(r));
  }

  private snapshot(req: any, user: AuthUser) {
    const path = req.originalUrl ?? req.url ?? '';
    const files = describeFiles(req);
    const body = sanitizeBody(req.body ?? null);

    return {
      actorId: user.id,
      actorName: user.name ?? null,
      actorRoles: user.roles ?? (user.role ? [user.role] : []),
      method: req.method,
      path: path.split('?')[0],
      resource: resourceOf(path),
      body: capPayload(files ? { ...(body ?? {}), _files: files } : body),
      params: capPayload(req.params ?? null),
      query: capPayload(req.query ?? null),
      ip: req.ip ?? req.headers?.['x-forwarded-for'] ?? null,
    };
  }
}
