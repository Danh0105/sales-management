import { EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { HrAuditAction } from '../audit/hr-audit-action';
import type { HrAuditActor } from '../audit/hr-audit-actor';
import type { HrAuditService } from '../audit/hr-audit.service';
import { HrEmployee, HrEmployeeStatus } from './entities/hr-employee.entity';
import { EMPLOYEE_CODE_SEQUENCE, formatEmployeeCode } from './hr-employee-code';
import {
  AttendanceMode,
  Gender,
  maskEmail,
  maskPhone,
  normalizeVietnameseName,
} from './hr-employee-profile';

/**
 * Ghi MỘT hồ sơ Employee Core — nguồn sự thật duy nhất cho cả API tạo hồ sơ
 * (`HrEmployeeService.create`) và import từ decision file (1.2.4):
 * mã NV do hệ thống sinh, `full_name_search` do server tính, audit
 * EMPLOYEE_CREATE (SĐT/email che, ngày sinh chỉ cờ). Chạy trong transaction
 * của nơi gọi.
 *
 * Chỉ Employee Core — không đơn vị, chức danh, quản lý, ngày vào làm, thử
 * việc, lương, trạng thái việc làm (Phase 1.4 / module tương ứng).
 */
export interface EmployeeCoreInput {
  fullName: string;
  accountId: number | null;
  /** Trạng thái HỒ SƠ (ACTIVE/INACTIVE), không phải trạng thái việc làm. */
  status: HrEmployeeStatus;
  attendanceMode: AttendanceMode;
  dateOfBirth: string | null;
  gender: Gender | null;
  phone: string | null;
  workEmail: string | null;
  personalEmail: string | null;
}

export type ProfileValues = Partial<
  Pick<
    HrEmployee,
    | 'fullName'
    | 'attendanceMode'
    | 'dateOfBirth'
    | 'gender'
    | 'phone'
    | 'workEmail'
    | 'personalEmail'
  >
>;

/**
 * Giá trị hồ sơ cho audit: họ tên, kiểu chấm công, giới tính lưu thẳng; SĐT
 * và email che một phần; ngày sinh KHÔNG lưu (chỉ cờ `dateOfBirthChanged`
 * do nơi gọi thêm); `fullNameSearch` không bao giờ vào audit.
 */
export function auditProfileValues(values: ProfileValues) {
  const out: Record<string, unknown> = {};
  if ('fullName' in values) out.fullName = values.fullName;
  if ('attendanceMode' in values) out.attendanceMode = values.attendanceMode;
  if ('gender' in values) out.gender = values.gender;
  if ('phone' in values) out.phone = maskPhone(values.phone ?? null);
  if ('workEmail' in values)
    out.workEmail = maskEmail(values.workEmail ?? null);
  if ('personalEmail' in values)
    out.personalEmail = maskEmail(values.personalEmail ?? null);
  return out;
}

/** Số mã NV tạo tay liên tiếp tối đa được bỏ qua trong một lần cấp. */
const MAX_CODE_SKIP = 100;

/**
 * Lấy mã NV kế tiếp từ sequence, bỏ qua mã `NV######` đã có (tạo tay trước
 * khi có sequence). Không tái sử dụng số đã lấy — rollback có thể để khoảng
 * trống, chấp nhận.
 */
export async function allocateEmployeeCode(
  manager: EntityManager,
): Promise<string> {
  for (let i = 0; i < MAX_CODE_SKIP; i++) {
    const [{ seq }] = await manager.query<{ seq: string }[]>(
      `SELECT nextval('${EMPLOYEE_CODE_SEQUENCE}') AS seq`,
    );
    const code = formatEmployeeCode(Number(seq));
    const [{ taken }] = await manager.query<{ taken: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "hr"."employees" WHERE "employee_code" = $1) AS taken`,
      [code],
    );
    if (!taken) return code;
  }
  throw new Error(
    'Không cấp được mã nhân viên: quá nhiều mã tạo tay liên tiếp',
  );
}

export async function insertEmployeeCore(
  manager: EntityManager,
  audit: HrAuditService,
  opts: {
    actor: HrAuditActor;
    actorAccountId: number | null;
    input: EmployeeCoreInput;
    /** Thông tin thêm cho audit (vd. `source`, `batchId` khi import). */
    auditExtra?: Record<string, unknown>;
  },
): Promise<HrEmployee> {
  const { input } = opts;
  const profile = {
    attendanceMode: input.attendanceMode,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    phone: input.phone,
    workEmail: input.workEmail,
    personalEmail: input.personalEmail,
  };
  const result = await manager.insert(HrEmployee, {
    employeeCode: await allocateEmployeeCode(manager),
    fullName: input.fullName,
    fullNameSearch: normalizeVietnameseName(input.fullName),
    accountId: input.accountId,
    status: input.status,
    ...profile,
    version: 1,
    createdBy: opts.actorAccountId,
    updatedBy: opts.actorAccountId,
  } as QueryDeepPartialEntity<HrEmployee>);
  const id = (result.identifiers[0] as { id: number }).id;
  const created = await manager.findOneOrFail(HrEmployee, { where: { id } });
  await audit.record(manager, {
    actor: opts.actor,
    action: HrAuditAction.EMPLOYEE_CREATE,
    entity: 'employee',
    entityId: id,
    newValue: {
      ...opts.auditExtra,
      employeeCode: created.employeeCode,
      accountId: created.accountId,
      status: created.status,
      ...auditProfileValues({ fullName: created.fullName, ...profile }),
      dateOfBirthChanged: created.dateOfBirth !== null,
    },
  });
  return created;
}
