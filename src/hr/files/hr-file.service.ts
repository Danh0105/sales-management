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
import { HrPermission } from '../access/hr-permission';
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
 * Truy cập: quyền theo LOẠI tài liệu + phạm vi nhân viên sở hữu → cấp URL ký
 * sẵn (adapter hỗ trợ) hoặc token 5 phút (adapter local) → tải qua
 * `.../content`, kiểm tra lại quyền lúc tải. Không phụ thuộc HrCryptoService.
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
    if (!policy.accessPermission) throw this.typeNotEnabled();
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

    const sha256 = sha256Hex(content);
    const storageKey = newStorageKey();
    // 1) Object trước — lỗi ở đây: chưa có dòng DB nào.
    await this.storage.put(storageKey, content, {
      contentType: type.mime,
      sha256,
    });

    // 2) Metadata + audit trong một transaction; lỗi → xoá bù object.
    try {
      return await this.dataSource.transaction(async (manager) => {
        if (identityDocumentId !== null) {
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
            await this.markArchived(
              manager,
              previous,
              actorId,
              'Thay bằng file tải lên mới',
            );
            await this.audit.record(manager, {
              actor,
              action: HrAuditAction.FILE_ARCHIVE,
              entity: AUDIT_ENTITY,
              entityId: previous.id,
              newValue: { ...this.auditFacts(previous), replaced: true },
              reason: 'Thay bằng file tải lên mới',
            });
          }
        }

        const result = await manager.insert(HrFile, {
          storageKey,
          originalName,
          mimeType: type.mime,
          sizeBytes: content.length,
          sha256,
          classification: policy.classification,
          documentType: dto.documentType,
          ownerEmployeeId: employee.id,
          identityDocumentId,
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
        return this.view(saved, true);
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
    const canSee = new Map<HrPermission, boolean>();
    for (const f of files) {
      const p = HR_FILE_DOCUMENT_POLICY[f.documentType]?.accessPermission;
      if (p && !canSee.has(p)) {
        canSee.set(
          p,
          await this.access.canAccess(actorId, p, employeeTarget(employee)),
        );
      }
    }
    return files.map((f) => {
      const p = HR_FILE_DOCUMENT_POLICY[f.documentType]?.accessPermission;
      return this.view(f, p ? (canSee.get(p) ?? false) : false);
    });
  }

  // ─── Cấp quyền truy cập nội dung ────────────────────────────────────

  async requestAccess(
    actorId: number,
    actor: HrAuditActor,
    fileId: number,
    reason: string | undefined,
  ) {
    const file = await this.findActive(fileId);
    const employee = await this.findOwner(file);
    const permission = this.accessPermissionOf(file);
    // Quyền theo loại tài liệu + phạm vi; ngoài phạm vi/không có quyền → 404.
    await this.access.assertCanAccess(
      actorId,
      permission,
      employeeTarget(employee),
    );
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
        newValue: { ...this.auditFacts(file), ttlSeconds, tokenId },
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
      file.status !== HrFileStatus.ACTIVE ||
      !HR_FILE_DOWNLOADABLE_SCAN_STATUSES.includes(file.scanStatus)
    ) {
      throw tokenInvalid();
    }
    // Kiểm tra lại quyền lúc tải: quyền bị thu hồi trong 5 phút → chặn.
    const employee = await this.findOwner(file);
    const permission =
      HR_FILE_DOCUMENT_POLICY[file.documentType]?.accessPermission;
    if (
      !permission ||
      !(await this.access.canAccess(
        grant.accountId,
        permission,
        employeeTarget(employee),
      ))
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
      await this.markArchived(manager, current, actorId, dto.reason);
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.FILE_ARCHIVE,
        entity: AUDIT_ENTITY,
        entityId: current.id,
        newValue: this.auditFacts(current),
        reason: dto.reason,
      });
      return { id: current.id, status: HrFileStatus.ARCHIVED };
    });
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

  private accessPermissionOf(file: HrFile): HrPermission {
    const permission =
      HR_FILE_DOCUMENT_POLICY[file.documentType]?.accessPermission;
    if (!permission) throw this.typeNotEnabled();
    return permission;
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

  private async findOwner(file: HrFile): Promise<HrEmployee> {
    const employee = await this.dataSource
      .getRepository(HrEmployee)
      .findOne({ where: { id: file.ownerEmployeeId } });
    if (!employee) throw new NotFoundException('Không tìm thấy dữ liệu');
    return employee;
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
