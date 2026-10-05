import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  Brackets,
  DataSource,
  EntityManager,
  QueryFailedError,
  SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrAccessService, HrGrant } from '../access/hr-access.service';
import {
  HrPermission,
  HrScope,
  UNRESTRICTED_SCOPES,
} from '../access/hr-permission';
import { HrAccessTarget } from '../access/hr-scope-resolver';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import { hrToday } from '../common/effective-date';
import {
  CreateHrEmployeeDto,
  ListHrEmployeesQuery,
  UpdateHrEmployeeDto,
} from './dto/create-hr-employee.dto';
import { HrEmployee, HrEmployeeStatus } from './entities/hr-employee.entity';
import { auditProfileValues, insertEmployeeCore } from './hr-employee-core';
import {
  buildSearchTerms,
  DEFAULT_PAGE_SIZE,
  escapeLike,
  isValidDateOfBirth,
  MAX_PAGE_SIZE,
  normalizeVietnameseName,
  phoneVariants,
} from './hr-employee-profile';

const UNIQUE_VIOLATION = '23505';
/** Số lần thử lấy mã kế tiếp khi đụng mã NV###### tạo tay trước đây. */
const MAX_CODE_ATTEMPTS = 5;

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string } | undefined)?.code ===
      UNIQUE_VIOLATION
  );
}

export function employeeTarget(e: HrEmployee): HrAccessTarget {
  return { employeeId: e.id, accountId: e.accountId };
}

/** Chi tiết hồ sơ. Không bao giờ có `fullNameSearch` (trường nội bộ). */
export function employeeView(e: HrEmployee) {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    fullName: e.fullName,
    accountId: e.accountId,
    status: e.status,
    attendanceMode: e.attendanceMode,
    dateOfBirth: e.dateOfBirth,
    gender: e.gender,
    phone: e.phone,
    workEmail: e.workEmail,
    personalEmail: e.personalEmail,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Dòng danh sách/ô chọn — tối thiểu dữ liệu cá nhân (không ngày sinh, giới tính, email cá nhân). */
export function employeeSummaryView(e: HrEmployee) {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    fullName: e.fullName,
    accountId: e.accountId,
    status: e.status,
    attendanceMode: e.attendanceMode,
    phone: e.phone,
    workEmail: e.workEmail,
    version: e.version,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/**
 * Phạm vi xem hồ sơ từ các grant EMPLOYEE_VIEW: COMPANY/ALL → tất cả; SELF →
 * hồ sơ gắn tài khoản của mình; TEAM/ORG_UNIT/BRANCH → chưa có dữ liệu việc
 * làm (Phase 1.4) → không ai (fail closed).
 */
export type EmployeeViewFilter =
  | { kind: 'ALL' }
  | { kind: 'NONE' }
  | { kind: 'SELF'; accountId: number };

export function employeeViewFilter(
  actorId: number,
  grants: HrGrant[],
): EmployeeViewFilter {
  const scopes = grants
    .filter((g) => g.permission === HrPermission.EMPLOYEE_VIEW)
    .map((g) => g.scope);
  if (scopes.some((s) => UNRESTRICTED_SCOPES.includes(s)))
    return { kind: 'ALL' };
  if (scopes.includes(HrScope.SELF))
    return { kind: 'SELF', accountId: actorId };
  return { kind: 'NONE' };
}

function applyViewFilter(
  qb: SelectQueryBuilder<HrEmployee>,
  filter: EmployeeViewFilter,
) {
  if (filter.kind === 'SELF')
    qb.andWhere('e.accountId = :scopeAccountId', {
      scopeAccountId: filter.accountId,
    });
}

export type DuplicateWarning = 'DUPLICATE_PHONE' | 'DUPLICATE_EMAIL';

/** Trường hồ sơ sửa được qua PATCH (không có mã NV, tài khoản, trường tìm kiếm). */
const EDITABLE_FIELDS = [
  'fullName',
  'attendanceMode',
  'dateOfBirth',
  'gender',
  'phone',
  'workEmail',
  'personalEmail',
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];
type ProfilePatch = Partial<Pick<HrEmployee, EditableField>>;

/** Định nghĩa ở `hr-employee-core` (dùng chung với import); giữ export ở đây. */
export { auditProfileValues };

function versionConflict() {
  return new ConflictException({
    statusCode: 409,
    code: 'HR_VERSION_CONFLICT',
    message: 'Dữ liệu đã bị người khác thay đổi — tải lại rồi thử lại',
  });
}

function assertDateOfBirth(value: string | null | undefined) {
  if (value === null || value === undefined) return;
  if (!isValidDateOfBirth(value, hrToday())) {
    throw new BadRequestException(
      'Ngày sinh không hợp lệ (ngày có thật, từ 01/01/1900 đến hôm nay)',
    );
  }
}

/**
 * Hồ sơ nhân sự cơ bản — KHÔNG đụng tầng mã hoá, nên vẫn chạy khi crypto
 * UNAVAILABLE.
 */
@Injectable()
export class HrEmployeeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: HrAccessService,
    private readonly audit: HrAuditService,
  ) {}

  /** Đọc hồ sơ + kiểm tra phạm vi. Ngoài phạm vi → 404 (chống IDOR). */
  async loadAuthorized(
    actorId: number,
    employeeId: number,
    permission: HrPermission,
  ): Promise<HrEmployee> {
    const employee = await this.dataSource
      .getRepository(HrEmployee)
      .findOne({ where: { id: employeeId } });
    if (!employee) throw new NotFoundException('Không tìm thấy dữ liệu');
    await this.access.assertCanAccess(
      actorId,
      permission,
      employeeTarget(employee),
    );
    return employee;
  }

  /**
   * Danh sách + tìm kiếm trong phạm vi EMPLOYEE_VIEW (grant do guard vừa đọc
   * từ DB). `q` là OR của: mã NV tiền tố, họ tên chứa (không dấu), SĐT chứa,
   * email chứa. Thứ tự cố định: họ tên, rồi id.
   */
  async list(actorId: number, grants: HrGrant[], query: ListHrEmployeesQuery) {
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const filter = employeeViewFilter(actorId, grants);
    if (filter.kind === 'NONE') return { data: [], total: 0, page, limit };

    const qb = this.dataSource
      .getRepository(HrEmployee)
      .createQueryBuilder('e')
      .orderBy('e.fullName', 'ASC')
      .addOrderBy('e.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    applyViewFilter(qb, filter);
    if (query.status)
      qb.andWhere('e.status = :status', { status: query.status });
    if (query.attendanceMode)
      qb.andWhere('e.attendanceMode = :attendanceMode', {
        attendanceMode: query.attendanceMode,
      });

    if (query.q) {
      const t = buildSearchTerms(query.q);
      const like = (v: string) => `%${escapeLike(v)}%`;
      qb.andWhere(
        new Brackets((w) => {
          // Điều kiện luôn sai làm gốc: q không khớp dạng nào → không kết quả.
          w.where('1 = 0');
          if (t.codePrefix)
            w.orWhere(`e.employeeCode LIKE :qCode ESCAPE '\\'`, {
              qCode: `${escapeLike(t.codePrefix)}%`,
            });
          if (t.nameContains)
            w.orWhere(`e.fullNameSearch LIKE :qName ESCAPE '\\'`, {
              qName: like(t.nameContains),
            });
          if (t.phoneContains)
            w.orWhere(`e.phone LIKE :qPhone ESCAPE '\\'`, {
              qPhone: like(t.phoneContains),
            });
          if (t.emailContains)
            w.orWhere(
              `(e.workEmail LIKE :qEmail ESCAPE '\\' OR e.personalEmail LIKE :qEmail ESCAPE '\\')`,
              { qEmail: like(t.emailContains) },
            );
        }),
      );
    }

    const [rows, total] = await qb.getManyAndCount();
    return { data: rows.map(employeeSummaryView), total, page, limit };
  }

  async get(actorId: number, employeeId: number) {
    return employeeView(
      await this.loadAuthorized(
        actorId,
        employeeId,
        HrPermission.EMPLOYEE_VIEW,
      ),
    );
  }

  async create(actorId: number, actor: HrAuditActor, dto: CreateHrEmployeeDto) {
    // Chưa có đối tượng để xét phạm vi: chỉ quyền không giới hạn (COMPANY/ALL)
    // được tạo hồ sơ — SELF không tự tạo hồ sơ cho mình.
    await this.access.assertCanAccess(
      actorId,
      HrPermission.EMPLOYEE_EDIT,
      {},
      {
        onDeny: 'forbidden',
      },
    );
    assertDateOfBirth(dto.dateOfBirth);

    const accountId = dto.accountId ?? null;
    if (accountId !== null) {
      const rows = await this.dataSource.query<{ id: number }[]>(
        `SELECT "id" FROM "public"."employee" WHERE "id" = $1`,
        [accountId],
      );
      if (!rows.length) {
        throw new BadRequestException('Tài khoản gắn với hồ sơ không tồn tại');
      }
    }

    const profile = {
      attendanceMode: dto.attendanceMode ?? 'UNASSIGNED',
      dateOfBirth: dto.dateOfBirth ?? null,
      gender: dto.gender ?? null,
      phone: dto.phone ?? null,
      workEmail: dto.workEmail ?? null,
      personalEmail: dto.personalEmail ?? null,
    } satisfies ProfilePatch;

    // Mã trùng chỉ xảy ra khi đụng một mã NV###### tạo tay trước khi có
    // sequence — lấy số kế tiếp. Trùng tài khoản thì báo ngay.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(async (manager) => {
          const created = await insertEmployeeCore(manager, this.audit, {
            actor,
            actorAccountId: actorId,
            input: {
              fullName: dto.fullName,
              accountId,
              status: HrEmployeeStatus.ACTIVE,
              ...profile,
            },
          });
          const warnings = await this.duplicateWarnings(
            manager,
            actorId,
            created,
            profile,
          );
          return { ...employeeView(created), warnings };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const constraint = (
          (error as QueryFailedError).driverError as { constraint?: string }
        )?.constraint;
        if (
          constraint === 'UQ_hr_employees_code' &&
          attempt < MAX_CODE_ATTEMPTS
        ) {
          continue;
        }
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_EMPLOYEE_DUPLICATE',
          message:
            constraint === 'UQ_hr_employees_code'
              ? 'Không sinh được mã nhân viên mới — thử lại'
              : 'Tài khoản đã gắn với hồ sơ khác',
        });
      }
    }
  }

  /**
   * Sửa hồ sơ cơ bản (EMPLOYEE_EDIT + phạm vi; ngoài phạm vi → 404). Đổi họ
   * tên thì `fullNameSearch` đổi trong CÙNG câu UPDATE. Không có thay đổi nào
   * → trả nguyên hồ sơ, không tăng version, không audit.
   */
  async update(
    actorId: number,
    actor: HrAuditActor,
    employeeId: number,
    dto: UpdateHrEmployeeDto,
  ) {
    // `@IsOptional` cho qua null — trường bắt buộc thì null là sai.
    if (dto.fullName === null)
      throw new BadRequestException('Họ tên không được để trống');
    if (dto.attendanceMode === null)
      throw new BadRequestException('Kiểu chấm công không được để trống');
    assertDateOfBirth(dto.dateOfBirth);

    return this.dataSource.transaction(async (manager) => {
      const current = await manager
        .getRepository(HrEmployee)
        .createQueryBuilder('e')
        .setLock('pessimistic_write')
        .where('e.id = :id', { id: employeeId })
        .getOne();
      if (!current) throw new NotFoundException('Không tìm thấy dữ liệu');
      await this.access.assertCanAccess(
        actorId,
        HrPermission.EMPLOYEE_EDIT,
        employeeTarget(current),
      );
      if (current.version !== dto.version) throw versionConflict();

      const patch: ProfilePatch = {};
      for (const field of EDITABLE_FIELDS) {
        const next = dto[field];
        if (next !== undefined && next !== current[field])
          (patch as Record<string, unknown>)[field] = next;
      }
      const changed = Object.keys(patch) as EditableField[];
      if (!changed.length) return { ...employeeView(current), warnings: [] };

      const result = await manager
        .createQueryBuilder()
        .update(HrEmployee)
        .set({
          ...patch,
          ...(patch.fullName !== undefined && {
            fullNameSearch: normalizeVietnameseName(patch.fullName),
          }),
          updatedBy: actorId,
          version: () => '"version" + 1',
          updatedAt: () => 'now()',
        } as QueryDeepPartialEntity<HrEmployee>)
        .where('id = :id AND version = :version', {
          id: employeeId,
          version: dto.version,
        })
        .execute();
      if (!result.affected) throw versionConflict();

      const before: ProfilePatch = {};
      for (const field of changed)
        (before as Record<string, unknown>)[field] = current[field];
      await this.audit.record(manager, {
        actor,
        action: HrAuditAction.EMPLOYEE_UPDATE,
        entity: 'employee',
        entityId: employeeId,
        oldValue: auditProfileValues(before),
        newValue: {
          ...auditProfileValues(patch),
          changedFields: changed,
          dateOfBirthChanged: changed.includes('dateOfBirth'),
        },
      });

      const updated = await manager.findOneOrFail(HrEmployee, {
        where: { id: employeeId },
      });
      const warnings = await this.duplicateWarnings(
        manager,
        actorId,
        updated,
        patch,
      );
      return { ...employeeView(updated), warnings };
    });
  }

  /**
   * Cảnh báo SĐT/email trùng hồ sơ khác — KHÔNG chặn (có người dùng chung số
   * hoặc email). Chỉ xét trường vừa ghi, và chỉ trong phạm vi EMPLOYEE_VIEW
   * của người thao tác: không tiết lộ hồ sơ ngoài phạm vi; không trả id hồ sơ
   * trùng.
   */
  private async duplicateWarnings(
    manager: EntityManager,
    actorId: number,
    employee: HrEmployee,
    written: ProfilePatch,
  ): Promise<DuplicateWarning[]> {
    const phone = 'phone' in written ? employee.phone : null;
    const emails = [
      'workEmail' in written ? employee.workEmail : null,
      'personalEmail' in written ? employee.personalEmail : null,
    ].filter((v): v is string => !!v);
    if (!phone && !emails.length) return [];

    const filter = employeeViewFilter(
      actorId,
      await this.access.getGrants(actorId, HrPermission.EMPLOYEE_VIEW),
    );
    if (filter.kind === 'NONE') return [];
    const others = () => {
      const qb = manager
        .getRepository(HrEmployee)
        .createQueryBuilder('e')
        .where('e.id <> :id', { id: employee.id });
      applyViewFilter(qb, filter);
      return qb;
    };

    const warnings: DuplicateWarning[] = [];
    if (
      phone &&
      (await others()
        .andWhere('e.phone IN (:...phones)', { phones: phoneVariants(phone) })
        .getExists())
    )
      warnings.push('DUPLICATE_PHONE');
    if (
      emails.length &&
      (await others()
        .andWhere(
          '(e.workEmail IN (:...emails) OR e.personalEmail IN (:...emails))',
          { emails },
        )
        .getExists())
    )
      warnings.push('DUPLICATE_EMAIL');
    return warnings;
  }
}
