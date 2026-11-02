import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { HrGrant } from '../access/hr-access.service';
import {
  HrPermission,
  HrScope,
  UNRESTRICTED_SCOPES,
} from '../access/hr-permission';
import { HrAuditAction } from '../audit/hr-audit-action';
import type { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import { HrEmployee } from '../employees/entities/hr-employee.entity';
import { HrEmployeeService } from '../employees/hr-employee.service';
import { HrFile } from '../files/entities/hr-file.entity';
import {
  HR_FILE_DOCUMENT_POLICY,
  HR_FILE_DOWNLOADABLE_SCAN_STATUSES,
  HrFileClassification,
  HrFileDocumentType,
  HrFileStatus,
} from '../files/hr-file-policy';
import { HrFileService } from '../files/hr-file.service';
import type { UploadedHrFile } from '../files/hr-file.service';
import {
  DOCUMENT_POLICY,
  documentDateProblems,
  DocumentType,
  EXPIRING_WITHIN_DAYS,
  expiryStatus,
} from './document-policy';
import {
  AddDocumentVersionDto,
  ArchiveDocumentDto,
  CreateDocumentDto,
  ExpiringDocumentsQuery,
  ListDocumentsQuery,
  UpdateDocumentDto,
} from './dto/document.dto';
import { EmployeeDocumentVersion } from './entities/employee-document-version.entity';
import { EmployeeDocument } from './entities/employee-document.entity';

const AUDIT_ENTITY = 'employee_document';

function versionConflict() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_VERSION_CONFLICT',
    message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
  });
}

function archivedConflict() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_DOCUMENT_ARCHIVED',
    message: 'Tài liệu đã lưu trữ — không thay đổi được',
  });
}

function invalid(problems: string[]) {
  return new BadRequestException({
    statusCode: 400,
    code: 'HR_DOCUMENT_INVALID',
    message: problems.join('; '),
  });
}

const classificationOf = (type: DocumentType) =>
  HR_FILE_DOCUMENT_POLICY[DOCUMENT_POLICY[type].fileType].classification;

/**
 * Hồ sơ tài liệu nhân viên (Phase 1.3). Dùng lại hoàn toàn Private Files 0.4C:
 * ghi file qua `HrFileService.storeDocumentFile` (cùng transaction với tài
 * liệu/phiên bản; lỗi → xoá bù object), xem/tải qua `POST files/:id/access` →
 * `GET files/:id/content` sẵn có, lưu trữ file qua `archiveWithin`.
 *
 * Quyền: DOCUMENT_VIEW (danh sách/metadata), DOCUMENT_MANAGE (ghi) — kèm phạm
 * vi nhân viên sở hữu (ngoài phạm vi → 404). Nội dung: quyền theo loại file
 * của 0.4C (giấy khám sức khỏe → HEALTH_DOCUMENT_VIEW).
 */
@Injectable()
export class HrDocumentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly employees: HrEmployeeService,
    private readonly files: HrFileService,
    private readonly audit: HrAuditService,
  ) {}

  // ─── Đọc ────────────────────────────────────────────────────────────

  async list(actorId: number, employeeId: number, query: ListDocumentsQuery) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.DOCUMENT_VIEW,
    );
    const status = query.status ?? 'ACTIVE';
    const documents = await this.dataSource
      .getRepository(EmployeeDocument)
      .find({
        where: {
          employeeId,
          ...(status !== 'ALL' && { status }),
          ...(query.type && { documentType: query.type }),
        },
        order: { documentType: 'ASC', id: 'ASC' },
      });
    const versions = documents.length
      ? await this.dataSource.getRepository(EmployeeDocumentVersion).find({
          where: { documentId: In(documents.map((d) => d.id)) },
          order: { versionNo: 'DESC' },
        })
      : [];
    // File GENERAL tải lên trước đây (0.4C, chưa gắn tài liệu) — hiển thị là OTHER.
    const legacy =
      !query.type || query.type === 'OTHER'
        ? await this.dataSource
            .getRepository(HrFile)
            .createQueryBuilder('f')
            .where('f.ownerEmployeeId = :employeeId', { employeeId })
            .andWhere('f.documentType = :general', {
              general: HrFileDocumentType.GENERAL,
            })
            .andWhere('f.status = :active', { active: HrFileStatus.ACTIVE })
            .andWhere(
              `NOT EXISTS (SELECT 1 FROM "hr"."employee_document_versions" v WHERE v."file_id" = f."id")`,
            )
            .orderBy('f.id', 'ASC')
            .getMany()
        : [];
    const allFileIds = [...versions.map((v) => v.fileId)];
    const files = allFileIds.length
      ? await this.dataSource
          .getRepository(HrFile)
          .find({ where: { id: In(allFileIds) } })
      : [];
    const fileById = new Map([...files, ...legacy].map((f) => [f.id, f]));
    const canSee = await this.files.contentVisibility(actorId, employee, [
      ...documents.map((d) => DOCUMENT_POLICY[d.documentType].fileType),
      ...(legacy.length ? [HrFileDocumentType.GENERAL] : []),
    ]);
    const today = hrToday();

    return {
      employeeId,
      documents: documents.map((d) =>
        this.view(
          d,
          versions.filter((v) => v.documentId === d.id),
          fileById,
          canSee.get(DOCUMENT_POLICY[d.documentType].fileType) ?? false,
          today,
        ),
      ),
      legacyOtherFiles: legacy.map((f) => ({
        documentType: 'OTHER' as const,
        canDownload:
          (canSee.get(HrFileDocumentType.GENERAL) ?? false) &&
          HR_FILE_DOWNLOADABLE_SCAN_STATUSES.includes(f.scanStatus),
        file: this.fileView(f, canSee.get(HrFileDocumentType.GENERAL) ?? false),
      })),
    };
  }

  /**
   * Tài liệu sắp hết hạn / đã hết hạn (còn ACTIVE). Theo phạm vi DOCUMENT_VIEW:
   * COMPANY/ALL → tất cả; SELF → của chính mình; TEAM/ORG_UNIT/BRANCH → chưa
   * có dữ liệu việc làm (Phase 1.4) → không ai.
   */
  async expiring(
    actorId: number,
    grants: readonly HrGrant[],
    query: ExpiringDocumentsQuery,
  ) {
    const withinDays = query.withinDays ?? EXPIRING_WITHIN_DAYS;
    const today = hrToday();
    const scopes = grants
      .filter((g) => g.permission === HrPermission.DOCUMENT_VIEW)
      .map((g) => g.scope);
    const unrestricted = scopes.some((s) => UNRESTRICTED_SCOPES.includes(s));
    if (!unrestricted && !scopes.includes(HrScope.SELF)) {
      return { today, withinDays, items: [] };
    }
    // Ngày tính từ `today` của ứng dụng (giờ Việt Nam) — không dùng CURRENT_DATE.
    const rows = await this.dataSource.query<
      {
        id: number;
        employeeId: number;
        employeeCode: string;
        fullName: string;
        documentType: DocumentType;
        title: string;
        expiresOn: string;
      }[]
    >(
      `SELECT d."id", d."employee_id" AS "employeeId", e."employee_code" AS "employeeCode",
              e."full_name" AS "fullName", d."document_type" AS "documentType", d."title",
              d."expires_on"::text AS "expiresOn"
         FROM "hr"."employee_documents" d
         JOIN "hr"."employees" e ON e."id" = d."employee_id"
        WHERE d."status" = 'ACTIVE'
          AND d."expires_on" IS NOT NULL
          AND d."expires_on" <= ($1::date + $2::int)
          AND ($3::boolean OR e."account_id" = $4)
        ORDER BY d."expires_on" ASC, d."id" ASC`,
      [today, withinDays, unrestricted, actorId],
    );
    return {
      today,
      withinDays,
      items: rows.map((r) => ({
        ...r,
        expiryStatus: expiryStatus(r.expiresOn, today, withinDays),
      })),
    };
  }

  // ─── Ghi ────────────────────────────────────────────────────────────

  async create(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: CreateDocumentDto,
    file: UploadedHrFile | undefined,
  ) {
    const employee = await this.employees.loadAuthorized(
      actorId,
      employeeId,
      HrPermission.DOCUMENT_MANAGE,
    );
    const today = hrToday();
    const dates = {
      issuedOn: dto.issuedOn ?? null,
      expiresOn: dto.expiresOn ?? null,
    };
    const problems = documentDateProblems(dto.documentType, dates, today);
    if (problems.length) throw invalid(problems);
    const policy = DOCUMENT_POLICY[dto.documentType];

    return this.files.storeDocumentFile({
      actorId,
      actor,
      employee,
      documentType: policy.fileType,
      file,
      afterInsert: async (manager, saved) => {
        const inserted = await manager.insert(EmployeeDocument, {
          employeeId,
          documentType: dto.documentType,
          title: dto.title,
          issuer: dto.issuer ?? null,
          ...dates,
          note: dto.note ?? null,
          status: 'ACTIVE',
          version: 1,
          createdBy: actorId,
          updatedBy: actorId,
        } as QueryDeepPartialEntity<EmployeeDocument>);
        const documentId = (inserted.identifiers[0] as { id: number }).id;
        const versionId = await this.insertVersion(
          manager,
          documentId,
          1,
          saved.id,
          null,
          actorId,
        );
        await manager.update(EmployeeDocument, documentId, {
          currentVersionId: versionId,
        });
        const doc = await manager.findOneByOrFail(EmployeeDocument, {
          id: documentId,
        });
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.DOCUMENT_CREATE,
          entity: AUDIT_ENTITY,
          entityId: documentId,
          newValue: {
            ...this.auditFacts(doc),
            versionNo: 1,
            fileId: saved.id,
          },
        });
        return this.reload(manager, actorId, employee, documentId);
      },
    });
  }

  async addVersion(
    actorId: number,
    actor: HrAuditActor,
    documentId: number,
    dto: AddDocumentVersionDto,
    file: UploadedHrFile | undefined,
  ) {
    const { doc, employee } = await this.loadForManage(actorId, documentId);
    if (doc.status !== 'ACTIVE') throw archivedConflict();
    // Báo sớm trước khi ghi object; kiểm tra lại dưới khoá trong transaction.
    if (doc.version !== dto.version) throw versionConflict();

    return this.files.storeDocumentFile({
      actorId,
      actor,
      employee,
      documentType: DOCUMENT_POLICY[doc.documentType].fileType,
      file,
      afterInsert: async (manager, saved) => {
        const current = await this.lockDocument(manager, documentId);
        if (current.status !== 'ACTIVE') throw archivedConflict();
        if (current.version !== dto.version) throw versionConflict();
        const [{ next }] = await manager.query<{ next: number }[]>(
          `SELECT coalesce(max("version_no"), 0)::int + 1 AS "next"
             FROM "hr"."employee_document_versions" WHERE "document_id" = $1`,
          [documentId],
        );
        const versionId = await this.insertVersion(
          manager,
          documentId,
          next,
          saved.id,
          dto.changeNote ?? null,
          actorId,
        );
        await this.bump(manager, documentId, actorId, {
          currentVersionId: versionId,
        });
        // ACTIVE chỉ còn nghĩa là phiên bản hiện hành (quyết định 05/10/2026).
        const previous = current.currentVersionId
          ? await manager.findOneBy(EmployeeDocumentVersion, {
              id: current.currentVersionId,
            })
          : null;
        if (previous) {
          await this.files.archiveWithin(
            manager,
            actorId,
            actor,
            previous.fileId,
            `Thay bằng phiên bản v${next}`,
          );
        }
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.DOCUMENT_VERSION_ADD,
          entity: AUDIT_ENTITY,
          entityId: documentId,
          newValue: {
            ...this.auditFacts(current),
            versionNo: next,
            fileId: saved.id,
            previousVersionId: current.currentVersionId,
          },
        });
        return this.reload(manager, actorId, employee, documentId);
      },
    });
  }

  async update(
    actorId: number,
    actor: HrAuditActor,
    documentId: number,
    dto: UpdateDocumentDto,
  ) {
    const { doc, employee } = await this.loadForManage(actorId, documentId);
    if (dto.title === null) throw invalid(['Tiêu đề không được để trống']);
    // Ghi chú của loại RESTRICTED (giấy khám) chỉ người xem được nội dung mới
    // sửa được — không cho "ghi đè mù" dữ liệu mình không được thấy.
    if (
      dto.note !== undefined &&
      classificationOf(doc.documentType) === HrFileClassification.RESTRICTED &&
      !(await this.files.canSeeContent(
        actorId,
        DOCUMENT_POLICY[doc.documentType].fileType,
        employee,
      ))
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'HR_DOCUMENT_NOTE_FORBIDDEN',
        message:
          'Không sửa được ghi chú: cần quyền xem nội dung loại tài liệu này',
      });
    }
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockDocument(manager, documentId);
      if (current.status !== 'ACTIVE') throw archivedConflict();
      if (current.version !== dto.version) throw versionConflict();

      const fields = [
        'title',
        'issuer',
        'issuedOn',
        'expiresOn',
        'note',
      ] as const;
      const patch: Partial<Pick<EmployeeDocument, (typeof fields)[number]>> =
        {};
      for (const f of fields) {
        const next = dto[f];
        if (next !== undefined && next !== current[f])
          (patch as Record<string, unknown>)[f] = next;
      }
      const changed = Object.keys(patch) as (typeof fields)[number][];
      if (!changed.length)
        return this.reload(manager, actorId, employee, documentId);
      const merged = {
        issuedOn:
          patch.issuedOn !== undefined ? patch.issuedOn : current.issuedOn,
        expiresOn:
          patch.expiresOn !== undefined ? patch.expiresOn : current.expiresOn,
      };
      const problems = documentDateProblems(
        current.documentType,
        merged,
        hrToday(),
      );
      if (problems.length) throw invalid(problems);

      await this.bump(manager, documentId, actorId, patch);
      const shown = changed.filter((f) => f !== 'note');
      const pick = (src: Record<string, unknown>) =>
        Object.fromEntries(shown.map((f) => [f, src[f] ?? null]));
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.DOCUMENT_UPDATE,
        entity: AUDIT_ENTITY,
        entityId: documentId,
        // Ghi chú có thể chứa thông tin cá nhân/sức khoẻ — chỉ ghi cờ đã đổi.
        oldValue: pick(current as unknown as Record<string, unknown>),
        newValue: {
          ...pick(patch),
          documentType: current.documentType,
          changedFields: changed,
          noteChanged: changed.includes('note'),
        },
      });
      return this.reload(manager, actorId, employee, documentId);
    });
  }

  async archive(
    actorId: number,
    actor: HrAuditActor,
    documentId: number,
    dto: ArchiveDocumentDto,
  ) {
    await this.loadForManage(actorId, documentId);
    return this.dataSource.transaction(async (manager) => {
      const current = await this.lockDocument(manager, documentId);
      if (current.status !== 'ACTIVE') throw archivedConflict();
      if (current.version !== dto.version) throw versionConflict();
      await manager
        .createQueryBuilder()
        .update(EmployeeDocument)
        .set({
          status: 'ARCHIVED',
          archivedAt: () => 'now()',
          archivedBy: actorId,
          archiveReason: dto.reason,
          updatedBy: actorId,
          updatedAt: () => 'now()',
          version: () => '"version" + 1',
        } as QueryDeepPartialEntity<EmployeeDocument>)
        .where('id = :id', { id: documentId })
        .execute();
      const versions = await manager.find(EmployeeDocumentVersion, {
        where: { documentId },
      });
      let archivedFiles = 0;
      for (const v of versions) {
        if (
          await this.files.archiveWithin(
            manager,
            actorId,
            actor,
            v.fileId,
            `Lưu trữ cùng tài liệu #${documentId}`,
          )
        )
          archivedFiles++;
      }
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.DOCUMENT_ARCHIVE,
        entity: AUDIT_ENTITY,
        entityId: documentId,
        newValue: { ...this.auditFacts(current), archivedFiles },
        reason: dto.reason,
      });
      return { id: documentId, status: 'ARCHIVED' as const };
    });
  }

  // ─── Dùng chung ─────────────────────────────────────────────────────

  /** Tài liệu + nhân viên sở hữu, kiểm tra DOCUMENT_MANAGE + phạm vi (ngoài phạm vi → 404). */
  private async loadForManage(actorId: number, documentId: number) {
    const doc = await this.dataSource
      .getRepository(EmployeeDocument)
      .findOne({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Không tìm thấy dữ liệu');
    const employee = await this.employees.loadAuthorized(
      actorId,
      doc.employeeId,
      HrPermission.DOCUMENT_MANAGE,
    );
    return { doc, employee };
  }

  private async lockDocument(manager: EntityManager, id: number) {
    const doc = await manager
      .getRepository(EmployeeDocument)
      .createQueryBuilder('d')
      .setLock('pessimistic_write')
      .where('d.id = :id', { id })
      .getOne();
    if (!doc) throw new NotFoundException('Không tìm thấy dữ liệu');
    return doc;
  }

  private async insertVersion(
    manager: EntityManager,
    documentId: number,
    versionNo: number,
    fileId: number,
    changeNote: string | null,
    actorId: number,
  ): Promise<number> {
    const inserted = await manager.insert(EmployeeDocumentVersion, {
      documentId,
      versionNo,
      fileId,
      changeNote,
      createdBy: actorId,
    } as QueryDeepPartialEntity<EmployeeDocumentVersion>);
    return (inserted.identifiers[0] as { id: number }).id;
  }

  private async bump(
    manager: EntityManager,
    documentId: number,
    actorId: number,
    patch: Partial<EmployeeDocument>,
  ) {
    await manager
      .createQueryBuilder()
      .update(EmployeeDocument)
      .set({
        ...patch,
        updatedBy: actorId,
        updatedAt: () => 'now()',
        version: () => '"version" + 1',
      } as QueryDeepPartialEntity<EmployeeDocument>)
      .where('id = :id', { id: documentId })
      .execute();
  }

  private async reload(
    manager: EntityManager,
    actorId: number,
    employee: HrEmployee,
    documentId: number,
  ) {
    const doc = await manager.findOneByOrFail(EmployeeDocument, {
      id: documentId,
    });
    const versions = await manager.find(EmployeeDocumentVersion, {
      where: { documentId },
      order: { versionNo: 'DESC' },
    });
    const files = versions.length
      ? await manager.find(HrFile, {
          where: { id: In(versions.map((v) => v.fileId)) },
        })
      : [];
    const canSee = await this.files.canSeeContent(
      actorId,
      DOCUMENT_POLICY[doc.documentType].fileType,
      employee,
    );
    return this.view(
      doc,
      versions,
      new Map(files.map((f) => [f.id, f])),
      canSee,
      hrToday(),
    );
  }

  private view(
    d: EmployeeDocument,
    versions: EmployeeDocumentVersion[],
    fileById: Map<number, HrFile>,
    canViewContent: boolean,
    today: string,
  ) {
    const classification = classificationOf(d.documentType);
    // Loại RESTRICTED (giấy khám): ghi chú chỉ hiện cho người xem được nội dung.
    const noteVisible =
      canViewContent || classification !== HrFileClassification.RESTRICTED;
    return {
      id: d.id,
      employeeId: d.employeeId,
      documentType: d.documentType,
      classification,
      title: d.title,
      issuer: d.issuer,
      issuedOn: d.issuedOn,
      expiresOn: d.expiresOn,
      expiryStatus:
        d.status === 'ACTIVE' ? expiryStatus(d.expiresOn, today) : null,
      note: noteVisible ? d.note : null,
      status: d.status,
      version: d.version,
      currentVersionId: d.currentVersionId,
      canViewContent,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      archivedAt: d.archivedAt,
      archiveReason: d.archiveReason,
      versions: versions.map((v) => {
        const f = fileById.get(v.fileId);
        const current = v.id === d.currentVersionId;
        return {
          id: v.id,
          versionNo: v.versionNo,
          current,
          changeNote: v.changeNote,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          // Bản hiện hành: file ACTIVE; bản cũ: ARCHIVED nhưng xem lại được
          // khi tài liệu còn ACTIVE (cùng luật với HrFileService).
          canDownload:
            !!f &&
            canViewContent &&
            d.status === 'ACTIVE' &&
            HR_FILE_DOWNLOADABLE_SCAN_STATUSES.includes(f.scanStatus) &&
            (f.status === HrFileStatus.ACTIVE ||
              (!current && f.status === HrFileStatus.ARCHIVED)),
          file: f ? this.fileView(f, canViewContent) : null,
        };
      }),
    };
  }

  /** Metadata file — tên file chỉ hiện cho người xem được nội dung (như 0.4C). */
  private fileView(f: HrFile, contentVisible: boolean) {
    return {
      id: f.id,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      scanStatus: f.scanStatus,
      status: f.status,
      classification: f.classification,
      originalName: contentVisible ? f.originalName : null,
      createdAt: f.createdAt,
    };
  }

  /** Không có nội dung file, tên file, ghi chú. */
  private auditFacts(d: EmployeeDocument) {
    return {
      documentId: d.id,
      employeeId: d.employeeId,
      documentType: d.documentType,
      classification: classificationOf(d.documentType),
      title: d.title,
      issuer: d.issuer,
      issuedOn: d.issuedOn,
      expiresOn: d.expiresOn,
    };
  }
}
