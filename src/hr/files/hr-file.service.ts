import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Readable } from 'stream';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrAccessService } from '../access/hr-access.service';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { HrEmployeeIdentityDocument } from '../employees/entities/hr-employee-identity-document.entity';
import { HrEmployee } from '../employees/entities/hr-employee.entity';
import {
  employeeTarget,
  HrEmployeeService,
} from '../employees/hr-employee.service';
import { ArchiveHrFileDto, UploadHrFileDto } from './dto/hr-file.dto';
import { HrFile } from './entities/hr-file.entity';
import { detectAllowedFileType, sanitizeOriginalName } from './hr-file-content';
import {
  fileRequiresAccessReason,
  HR_FILE_ACCESS_TTL_SECONDS,
  HR_FILE_DOCUMENT_POLICY,
  HR_FILE_DOWNLOADABLE_SCAN_STATUSES,
  HR_FILE_LIST_PERMISSION,
  HR_FILE_UPLOAD_PERMISSION,
  HR_PRIVATE_FILE_MAX_BYTES,
  HrFileDocumentType,
  HrFileScanStatus,
  HrFileStatus,
} from './hr-file-policy';
import {
  HR_PRIVATE_STORAGE,
  newStorageKey,
  storageUnavailable,
} from './storage/hr-private-storage';
import type { HrPrivateStorage } from './storage/hr-private-storage';

export interface UploadedHrFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

const AUDIT_ENTITY = 'hr_file';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function tokenInvalid() {
  // Một câu trả lời cho mọi lý do (sai, hết hạn, file khác, đã lưu trữ) — không làm oracle.
  return new ForbiddenException({
    statusCode: 403,
    code: 'HR_FILE_TOKEN_INVALID',
    message: 'Liên kết tải tài liệu không hợp lệ hoặc đã hết hạn',
  });
}

const sha256Hex = (data: Buffer | string) =>
  createHash('sha256').update(data).digest('hex');

/**
 * Tài liệu HR riêng tư.
 *
 * Upload (nhất quán kho ↔ DB): kiểm tra quyền/phạm vi/loại/kích thước → ghi
 * object với key ngẫu nhiên (không ghi đè) → transaction DB (metadata + audit)
 * → DB lỗi thì XOÁ BÙ object. Lỗi kho → không có dòng DB nào. Chết giữa chừng
 * (sau ghi object, trước commit) → object mồ côi, không ai tham chiếu, không
 * truy cập được; phát hiện bằng đối soát kho ↔ `hr.files`.
 *
 * Truy cập: quyền theo LOẠI tài liệu (một trong các quyền của loại) + phạm vi
 * nhân viên sở hữu → cấp URL ký sẵn (adapter hỗ trợ) hoặc token 5 phút
 * (adapter local) → tải qua `.../content`, kiểm tra lại quyền lúc tải. Không
 * phụ thuộc HrCryptoService.
 *
 * Phase 1.3: module Documents dùng lại `storeDocumentFile` (ghi file trong
 * transaction của phiên bản tài liệu), `archiveWithin`, `canSeeContent` — không
 * có kho, endpoint tải hay token thứ hai.
 */
@Injectable()
export class HrFileService {
  private readonly logger = new Logger(HrFileService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employees: HrEmployeeService,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
    @Inject(HR_PRIVATE_STORAGE) private readonly storage: HrPrivateStorage,
  ) {}

  // ─── Upload ──────────────────────────────────────────────────────────

  async upload(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: UploadHrFileDto,
    file: UploadedHrFile | undefined,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HR_FILE_UPLOAD_PERMISSION,
    );
    const policy = HR_FILE_DOCUMENT_POLICY[dto.documentType];
    if (!policy.accessPermissions.length) throw this.typeNotEnabled();
    if (policy.managedByDocuments) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'HR_FILE_USE_DOCUMENTS',
        message: 'Loại tài liệu này tải lên qua mục Tài liệu (Documents)',
      });
    }

    let identityDocumentId: number | null = null;
    if (policy.identityRelation) {
      if (!dto.identityDocumentId) {
        throw new BadRequestException(
          'identityDocumentId bắt buộc với ảnh giấy tờ tuỳ thân',
        );
      }
      const doc = await this.dataSource
        .getRepository(HrEmployeeIdentityDocument)
        .findOne({ where: { id: dto.identityDocumentId, employeeId } });
      if (!doc) throw new NotFoundException('Không tìm thấy dữ liệu');
      identityDocumentId = doc.id;
    } else if (dto.identityDocumentId !== undefined) {
      throw new BadRequestException(
        'identityDocumentId chỉ dùng cho IDENTITY_FRONT / IDENTITY_BACK',
      );
    }

    return this.ingest({
      actorId,
      actor,
      employee,
      documentType: dto.documentType,
      identityDocumentId,
      file,
      beforeInsert: async (manager) => {
        if (identityDocumentId === null) return;
        // Khoá giấy tờ: hai upload cùng mặt chạy tuần tự, bản sau thay bản trước.
        await manager
          .getRepository(HrEmployeeIdentityDocument)
          .createQueryBuilder('d')
          .setLock('pessimistic_write')
          .where('d.id = :id', { id: identityDocumentId })
          .getOne();
        const previous = await manager.findOne(HrFile, {
          where: {
            identityDocumentId,
            documentType: dto.documentType,
            status: HrFileStatus.ACTIVE,
          },
        });
        if (previous) {
          await this.archiveRecord(
            manager,
            previous,
            actorId,
            actor,
            'Thay bằng file tải lên mới',
            { replaced: true },
          );
        }
      },
      afterInsert: (_manager, saved) => Promise.resolve(this.view(saved, true)),
    });
  }

  /**
   * Phase 1.3 — ghi file cho một phiên bản tài liệu (module Documents). Nơi gọi
   * ĐÃ kiểm tra quyền/phạm vi của chính nó; `afterInsert` chạy trong CÙNG
   * transaction với dòng `hr.files` (lỗi ở đó → rollback + xoá bù object).
   */
  storeDocumentFile<R>(params: {
    actorId: number;
    actor: HrAuditActor;
    employee: HrEmployee;
    documentType: HrFileDocumentType;
    file: UploadedHrFile | undefined;
    afterInsert: (manager: EntityManager, saved: HrFile) => Promise<R>;
  }): Promise<R> {
    const policy = HR_FILE_DOCUMENT_POLICY[params.documentType];
    const allowed =
      policy.managedByDocuments ||
      params.documentType === HrFileDocumentType.GENERAL;
    if (!policy.accessPermissions.length || !allowed) {
      throw this.typeNotEnabled();
    }
    return this.ingest({ ...params, identityDocumentId: null });
  }

  /**
   * Kiểm tra file → ghi object (key ngẫu nhiên, không ghi đè) → transaction DB
   * (dòng `hr.files` + audit FILE_UPLOAD + phần việc của nơi gọi) → DB lỗi thì
   * XOÁ BÙ object.
   */
  private async ingest<R>(params: {
    actorId: number;
    actor: HrAuditActor;
    employee: HrEmployee;
    documentType: HrFileDocumentType;
    identityDocumentId: number | null;
    file: UploadedHrFile | undefined;
    beforeInsert?: (manager: EntityManager) => Promise<void>;
    afterInsert: (manager: EntityManager, saved: HrFile) => Promise<R>;
  }): Promise<R> {
    const { actorId, actor, employee, file } = params;
    const policy = HR_FILE_DOCUMENT_POLICY[params.documentType];
    if (!this.storage.available) throw storageUnavailable();

    const content = file?.buffer;
    if (!content?.length) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'HR_FILE_REQUIRED',
        message: 'Thiếu file (field "file") hoặc file rỗng',
      });
    }
    if (content.length > HR_PRIVATE_FILE_MAX_BYTES) {
      throw new PayloadTooLargeException({
        statusCode: 413,
        code: 'HR_FILE_TOO_LARGE',
        message: `File vượt ${HR_PRIVATE_FILE_MAX_BYTES / 1024 / 1024} MB`,
      });
    }
    const originalName = sanitizeOriginalName(file?.originalname);
    const type = detectAllowedFileType(content, file?.mimetype, originalName);
    if (!type.ok) {
      throw new UnsupportedMediaTypeException({
        statusCode: 415,
        code: 'HR_FILE_TYPE_NOT_ALLOWED',
        reason: type.reason,
        message:
          'Chỉ nhận PDF, JPEG, PNG (nội dung, MIME và đuôi file phải khớp)',
      });
    }

    const sha256 = sha256Hex(content);
    const storageKey = newStorageKey();
    // 1) Object trước — lỗi ở đây: chưa có dòng DB nào.
    await this.storage.put(storageKey, content, {
      contentType: type.mime,
      sha256,
    });

    // 2) Metadata + audit (+ phần việc của nơi gọi) trong một transaction; lỗi → xoá bù object.
    try {
      return await this.dataSource.transaction(async (manager) => {
        await params.beforeInsert?.(manager);
        const result = await manager.insert(HrFile, {
          storageKey,
          originalName,
          mimeType: type.mime,
          sizeBytes: content.length,
          sha256,
          classification: policy.classification,
          documentType: params.documentType,
          ownerEmployeeId: employee.id,
          identityDocumentId: params.identityDocumentId,
          status: HrFileStatus.ACTIVE,
          scanStatus: HrFileScanStatus.NOT_SCANNED,
          uploadedBy: actorId,
          version: 1,
        } as QueryDeepPartialEntity<HrFile>);
        const id = (result.identifiers[0] as { id: number }).id;
        const saved = await manager.findOneByOrFail(HrFile, { id });
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.FILE_UPLOAD,
          entity: AUDIT_ENTITY,
          entityId: id,
          newValue: {
            ...this.auditFacts(saved),
            mimeType: saved.mimeType,
            sizeBytes: saved.sizeBytes,
            sha256: saved.sha256,
            scanStatus: saved.scanStatus,
          },
        });
        return params.afterInsert(manager, saved);
      });
    } catch (error) {
      await this.compensate(storageKey);
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string })?.code === '23505'
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_FILE_CONFLICT',
          message: 'Có thay đổi đồng thời — thử lại',
        });
      }
      throw error;
    }
  }

  // ─── Danh sách metadata ─────────────────────────────────────────────

  async list(actorId: number, employeeId: number) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HR_FILE_LIST_PERMISSION,
    );
    const files = await this.dataSource.getRepository(HrFile).find({
      where: { ownerEmployeeId: employeeId, status: HrFileStatus.ACTIVE },
      order: { id: 'ASC' },
    });
    // Tên file gốc có thể chứa số định danh → chỉ hiện cho người xem được nội dung.
    const canSee = await this.contentVisibility(
      actorId,
      employee,
      files.map((f) => f.documentType),
    );
    return files.map((f) => this.view(f, canSee.get(f.documentType) ?? false));
  }

  // ─── Cấp quyền truy cập nội dung ────────────────────────────────────

  async requestAccess(
    actorId: number,
    actor: HrAuditActor,
    fileId: number,
    reason: string | undefined,
  ) {
    const { file, superseded } = await this.findViewable(fileId);
    const employee = await this.findOwner(file);
    // Quyền theo loại tài liệu + phạm vi; ngoài phạm vi/không có quyền → 404.
    if (!HR_FILE_DOCUMENT_POLICY[file.documentType]?.accessPermissions.length) {
      throw this.typeNotEnabled();
    }
    if (!(await this.canSeeContent(actorId, file.documentType, employee))) {
      throw new NotFoundException('Không tìm thấy dữ liệu');
    }
    if (fileRequiresAccessReason(file.classification) && !reason?.trim()) {
      throw new BadRequestException('Tài liệu hạn chế: bắt buộc nhập lý do');
    }
    if (!HR_FILE_DOWNLOADABLE_SCAN_STATUSES.includes(file.scanStatus)) {
      throw new ConflictException({
        statusCode: 409,
        code: 'HR_FILE_SCAN_BLOCKED',
        message: 'Tài liệu chưa qua kiểm tra an toàn hoặc bị chặn',
      });
    }
    if (!this.storage.available) throw storageUnavailable();

    const ttlSeconds = HR_FILE_ACCESS_TTL_SECONDS;
    return this.dataSource.transaction(async (manager) => {
      let url: string;
      let expiresAt: Date;
      let tokenId: number | null = null;
      if (this.storage.supportsSignedUrls) {
        const signed = await this.storage.getSignedReadUrl(file.storageKey, {
          ttlSeconds,
          contentType: file.mimeType,
          downloadName: file.originalName,
        });
        url = signed.url;
        expiresAt = signed.expiresAt;
      } else {
        const token = randomBytes(32).toString('base64url');
        const [row] = await manager.query<{ id: number; expires_at: Date }[]>(
          `INSERT INTO "hr"."file_access_tokens" ("file_id", "token_hash", "account_id", "expires_at")
           VALUES ($1, $2, $3, now() + make_interval(secs => $4))
           RETURNING "id", "expires_at"`,
          [file.id, sha256Hex(token), actorId, ttlSeconds],
        );
        tokenId = row.id;
        expiresAt = new Date(row.expires_at);
        url = `/api/hr/v1/files/${file.id}/content?token=${token}`;
      }
      // Audit KHÔNG chứa URL/token/đường dẫn — chỉ id token để đối chiếu.
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.FILE_ACCESS,
        entity: AUDIT_ENTITY,
        entityId: file.id,
        newValue: {
          ...this.auditFacts(file),
          ttlSeconds,
          tokenId,
          ...(superseded && { superseded: true }),
        },
        reason: reason?.trim() || null,
      });
      return { fileId: file.id, url, expiresAt, ttlSeconds };
    });
  }

  // ─── Tải nội dung bằng token ────────────────────────────────────────

  async openContent(
    fileId: number,
    token: string | undefined,
    requestActor: HrAuditActor,
  ): Promise<{ file: HrFile; stream: Readable }> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw tokenInvalid();
    }
    const [grant] = await this.dataSource.query<
      { tokenId: number; accountId: number }[]
    >(
      `SELECT "id" AS "tokenId", "account_id" AS "accountId"
         FROM "hr"."file_access_tokens"
        WHERE "token_hash" = $1 AND "file_id" = $2 AND "expires_at" > now()`,
      [sha256Hex(token), fileId],
    );
    if (!grant) throw tokenInvalid();

    const file = await this.dataSource
      .getRepository(HrFile)
      .findOne({ where: { id: fileId } });
    if (
      !file ||
      !(
        file.status === HrFileStatus.ACTIVE ||
        (file.status === HrFileStatus.ARCHIVED &&
          (await this.isSupersededVersion(file.id)))
      ) ||
      !HR_FILE_DOWNLOADABLE_SCAN_STATUSES.includes(file.scanStatus)
    ) {
      throw tokenInvalid();
    }
    // Kiểm tra lại quyền lúc tải: quyền bị thu hồi trong 5 phút → chặn.
    const employee = await this.findOwner(file);
    if (
      !(await this.canSeeContent(grant.accountId, file.documentType, employee))
    ) {
      throw tokenInvalid();
    }
    if (!this.storage.available) throw storageUnavailable();

    const stat = await this.storage.stat(file.storageKey);
    if (!stat || stat.sizeBytes !== file.sizeBytes) {
      this.logger.error(`Nội dung file #${file.id} thiếu hoặc sai kích thước`);
      throw new InternalServerErrorException({
        statusCode: 500,
        code: 'HR_FILE_INTEGRITY',
        message: 'Không đọc được tài liệu',
      });
    }
    await this.audit.recordStandalone({
      actor: { ...requestActor, accountId: grant.accountId },
      action: HrAuditAction.FILE_DOWNLOAD,
      entity: AUDIT_ENTITY,
      entityId: file.id,
      newValue: { ...this.auditFacts(file), tokenId: grant.tokenId },
    });
    return { file, stream: await this.storage.openRead(file.storageKey) };
  }

  // ─── Lưu trữ (soft) ────────────────────────────────────────────────

  async archive(
    actorId: number,
    actor: HrAuditActor,
    fileId: number,
    dto: ArchiveHrFileDto,
  ) {
    const file = await this.findActive(fileId);
    await this.employees.loadAuthorized(
      actorId,
      file.ownerEmployeeId,
      HR_FILE_UPLOAD_PERMISSION,
    );
    return this.dataSource.transaction(async (manager) => {
      const current = await manager
        .getRepository(HrFile)
        .createQueryBuilder('f')
        .setLock('pessimistic_write')
        .where('f.id = :id', { id: fileId })
        .getOne();
      if (!current || current.status !== HrFileStatus.ACTIVE) {
        throw new NotFoundException('Không tìm thấy dữ liệu');
      }
      if (current.version !== dto.version) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_VERSION_CONFLICT',
          message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
        });
      }
      await this.archiveRecord(manager, current, actorId, actor, dto.reason);
      return { id: current.id, status: HrFileStatus.ARCHIVED };
    });
  }

  /**
   * Phase 1.3 — lưu trữ (soft) một file trong transaction của nơi gọi, kèm
   * audit FILE_ARCHIVE. File không còn ACTIVE → bỏ qua (trả false).
   */
  async archiveWithin(
    manager: EntityManager,
    actorId: number,
    actor: HrAuditActor,
    fileId: number,
    reason: string,
  ): Promise<boolean> {
    const current = await manager
      .getRepository(HrFile)
      .createQueryBuilder('f')
      .setLock('pessimistic_write')
      .where('f.id = :id', { id: fileId })
      .getOne();
    if (!current || current.status !== HrFileStatus.ACTIVE) return false;
    await this.archiveRecord(manager, current, actorId, actor, reason);
    return true;
  }

  // ─── Quyền xem nội dung ─────────────────────────────────────────────

  /**
   * Người dùng xem được NỘI DUNG loại file này của nhân viên này không: có
   * MỘT trong các quyền của loại (kèm phạm vi nhân viên sở hữu).
   */
  async canSeeContent(
    actorId: number,
    documentType: HrFileDocumentType,
    employee: HrEmployee,
  ): Promise<boolean> {
    const permissions =
      HR_FILE_DOCUMENT_POLICY[documentType]?.accessPermissions ?? [];
    for (const permission of permissions) {
      if (
        await this.access.canAccess(
          actorId,
          permission,
          employeeTarget(employee),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** `canSeeContent` cho nhiều loại một lúc (mỗi loại hỏi một lần). */
  async contentVisibility(
    actorId: number,
    employee: HrEmployee,
    types: HrFileDocumentType[],
  ): Promise<Map<HrFileDocumentType, boolean>> {
    const out = new Map<HrFileDocumentType, boolean>();
    for (const t of new Set(types)) {
      out.set(t, await this.canSeeContent(actorId, t, employee));
    }
    return out;
  }

  // ─── Dùng chung ────────────────────────────────────────────────────

  private view(f: HrFile, contentVisible: boolean) {
    return {
      id: f.id,
      employeeId: f.ownerEmployeeId,
      documentType: f.documentType,
      classification: f.classification,
      identityDocumentId: f.identityDocumentId,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      scanStatus: f.scanStatus,
      status: f.status,
      originalName: contentVisible ? f.originalName : null,
      version: f.version,
      createdAt: f.createdAt,
    };
  }

  /** Không có URL, token, storage key, đường dẫn hay tên file. */
  private auditFacts(f: HrFile) {
    return {
      fileId: f.id,
      employeeId: f.ownerEmployeeId,
      documentType: f.documentType,
      classification: f.classification,
      identityDocumentId: f.identityDocumentId,
    };
  }

  private typeNotEnabled() {
    return new ForbiddenException({
      statusCode: 403,
      code: 'HR_FILE_TYPE_NOT_ENABLED',
      message: 'Loại tài liệu này chưa có quyền truy cập tương ứng',
    });
  }

  private async findActive(fileId: number): Promise<HrFile> {
    const file = await this.dataSource
      .getRepository(HrFile)
      .findOne({ where: { id: fileId } });
    if (!file || file.status !== HrFileStatus.ACTIVE) {
      throw new NotFoundException('Không tìm thấy dữ liệu');
    }
    return file;
  }

  /**
   * File xin xem được: ACTIVE, HOẶC (Phase 1.3) ARCHIVED vì là PHIÊN BẢN CŨ của
   * một tài liệu còn ACTIVE — người có quyền vẫn xem lại lịch sử. File lưu trữ
   * bằng thao tác 0.4C và mọi file của tài liệu đã lưu trữ vẫn bị chặn.
   */
  private async findViewable(
    fileId: number,
  ): Promise<{ file: HrFile; superseded: boolean }> {
    const file = await this.dataSource
      .getRepository(HrFile)
      .findOne({ where: { id: fileId } });
    if (file?.status === HrFileStatus.ACTIVE)
      return { file, superseded: false };
    if (
      file?.status === HrFileStatus.ARCHIVED &&
      (await this.isSupersededVersion(file.id))
    ) {
      return { file, superseded: true };
    }
    throw new NotFoundException('Không tìm thấy dữ liệu');
  }

  /** File là phiên bản cũ (không phải hiện hành) của một tài liệu còn ACTIVE. */
  private async isSupersededVersion(fileId: number): Promise<boolean> {
    const [row] = await this.dataSource.query<{ ok: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM "hr"."employee_document_versions" v
           JOIN "hr"."employee_documents" d ON d."id" = v."document_id"
          WHERE v."file_id" = $1 AND d."status" = 'ACTIVE'
            AND v."id" IS DISTINCT FROM d."current_version_id"
       ) AS "ok"`,
      [fileId],
    );
    return row?.ok === true;
  }

  private async findOwner(file: HrFile): Promise<HrEmployee> {
    const employee = await this.dataSource
      .getRepository(HrEmployee)
      .findOne({ where: { id: file.ownerEmployeeId } });
    if (!employee) throw new NotFoundException('Không tìm thấy dữ liệu');
    return employee;
  }

  private async archiveRecord(
    manager: EntityManager,
    file: HrFile,
    actorId: number,
    actor: HrAuditActor,
    reason: string,
    extra: Record<string, unknown> = {},
  ) {
    await this.markArchived(manager, file, actorId, reason);
    await this.audit.record(manager, {
      actor,
      action: HrAuditAction.FILE_ARCHIVE,
      entity: AUDIT_ENTITY,
      entityId: file.id,
      newValue: { ...this.auditFacts(file), ...extra },
      reason,
    });
  }

  private async markArchived(
    manager: EntityManager,
    file: HrFile,
    actorId: number,
    reason: string,
  ) {
    await manager
      .createQueryBuilder()
      .update(HrFile)
      .set({
        status: HrFileStatus.ARCHIVED,
        archivedAt: () => 'now()',
        archivedBy: actorId,
        archiveReason: reason,
        version: () => '"version" + 1',
      } as QueryDeepPartialEntity<HrFile>)
      .where('id = :id AND status = :active', {
        id: file.id,
        active: HrFileStatus.ACTIVE,
      })
      .execute();
  }

  /** Xoá bù object khi transaction DB thất bại. Không xoá được → log key (ngẫu nhiên, không nhạy cảm) để đối soát. */
  private async compensate(storageKey: string) {
    try {
      await this.storage.delete(storageKey);
    } catch (err) {
      this.logger.error(
        `Không xoá bù được object mồ côi ${storageKey} (${(err as Error)?.name ?? 'Error'}) — cần đối soát kho`,
      );
    }
  }
}
