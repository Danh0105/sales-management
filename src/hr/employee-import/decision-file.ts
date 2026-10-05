import { createHash } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateHrEmployeeDto } from '../employees/dto/create-hr-employee.dto';
import { HrEmployeeStatus } from '../employees/entities/hr-employee.entity';
import type { EmployeeCoreInput } from '../employees/hr-employee-core';
import {
  isValidDateOfBirth,
  normalizeProfileEmail,
  normalizeProfilePhone,
  PHONE_PATTERN,
  phoneVariants,
} from '../employees/hr-employee-profile';
import { parseCsv, toCsvText } from './csv';
import type { AnalysisRow } from './legacy-employee-classifier';

/**
 * Decision file (Phase 1.2.4) — người duyệt quyết định TỪNG tài khoản cũ:
 * IMPORT / SKIP / REVIEW. Chỉ IMPORT được ghi; còn bất kỳ REVIEW hoặc giá trị
 * lạ → toàn bộ apply dừng (không đoán). Thuần (không I/O).
 *
 * Chỉ Employee Core. `orgUnitCode` chỉ là ĐỀ XUẤT giữ lại cho Phase 1.4 —
 * không ghi vào hồ sơ. Không có cột định danh nhạy cảm, ngày vào làm, chức
 * danh, quản lý, lương, hợp đồng, trạng thái việc làm — có cột đó → lỗi.
 */
export const DECISIONS = ['IMPORT', 'SKIP', 'REVIEW'] as const;
export type Decision = (typeof DECISIONS)[number];

/** Cột người duyệt điền/sửa (import đọc). */
export const DECISION_COLUMNS = [
  'accountId',
  'decision',
  'fullName',
  'attendanceMode',
  'phone',
  'workEmail',
  'personalEmail',
  'dateOfBirth',
  'gender',
  'orgUnitCode',
  'note',
] as const;
/** Cột tham khảo từ phân tích 1.2.1 (import bỏ qua). */
export const REFERENCE_COLUMNS = [
  'legacyName',
  'legacyEmail',
  'legacyPhone',
  'legacyRoles',
  'legacyDepartment',
  'accountActive',
  'category',
  'analysis',
  'analysisWarnings',
] as const;
const REQUIRED_COLUMNS = ['accountId', 'decision'];
const ALLOWED = new Set<string>([...DECISION_COLUMNS, ...REFERENCE_COLUMNS]);

export function checksumOf(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Template từ kết quả phân tích ─────────────────────────────────────

/**
 * Bản nháp decision file từ phân tích 1.2.1. KHÔNG tự quyết thay người duyệt:
 * dòng phân tích NO (CTV, test, kỹ thuật, khoá, đã liên kết) → SKIP kèm lý do;
 * mọi dòng khác → REVIEW (người duyệt đổi thành IMPORT hoặc SKIP). SĐT/email
 * cũ chỉ điền sẵn khi hợp lệ.
 */
export function toDecisionTemplate(rows: AnalysisRow[]): string {
  const header = [...DECISION_COLUMNS, ...REFERENCE_COLUMNS];
  const body = rows.map((r) => {
    const phone = normalizeProfilePhone(r.phone ?? '');
    const email = normalizeProfileEmail(r.email ?? '');
    const draft: Record<string, string | number | boolean> = {
      accountId: r.accountId,
      decision: r.importable === 'NO' ? 'SKIP' : 'REVIEW',
      fullName: r.name,
      attendanceMode: r.proposedAttendanceMode,
      phone: PHONE_PATTERN.test(phone) ? phone : '',
      workEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
      personalEmail: '',
      dateOfBirth: '',
      gender: '',
      orgUnitCode: r.proposedOrgUnitCode ?? '',
      note: r.importable === 'NO' ? `Không nhập: ${r.warnings.join('|')}` : '',
      legacyName: r.name,
      legacyEmail: r.email,
      legacyPhone: r.phone,
      legacyRoles: r.legacyRoles,
      legacyDepartment: r.department,
      accountActive: r.isActive,
      category: r.category,
      analysis: r.importable,
      analysisWarnings: r.warnings.join('|'),
    };
    return header.map((c) => draft[c]);
  });
  return toCsvText(header, body);
}

// ─── Đọc + kiểm tra ────────────────────────────────────────────────────

export interface DecisionRow {
  line: number;
  values: Record<string, string>;
}

export function parseDecisionFile(text: string): {
  header: string[];
  rows: DecisionRow[];
} {
  const [header = [], ...data] = parseCsv(text);
  return {
    header: header.map((h) => h.trim()),
    rows: data.map((cells, i) => ({
      line: i + 2,
      values: Object.fromEntries(
        header.map((h, j) => [h.trim(), (cells[j] ?? '').trim()]),
      ),
    })),
  };
}

/** Trạng thái hiện có cần để kiểm tra (đọc từ DB). */
export interface ImportState {
  accounts: Map<number, { isActive: boolean }>;
  /** account_id đã gắn với hồ sơ HR → mã NV. */
  linkedAccounts: Map<number, string>;
  /** Đơn vị đang hoạt động hôm nay: mã → id. */
  activeOrgUnits: Map<string, number>;
  existingPhones: Set<string>;
  existingEmails: Set<string>;
}

export interface ImportPlanRow {
  line: number;
  accountId: number;
  input: EmployeeCoreInput;
  proposedOrgUnitId: number | null;
}

export interface DecisionValidation {
  errors: string[];
  warnings: string[];
  toImport: ImportPlanRow[];
  /** Dòng IMPORT hợp lệ (sẽ ghi nếu không còn lỗi nào). */
  importCount: number;
  /** Dòng IMPORT bị lỗi. */
  failedCount: number;
  skipCount: number;
  reviewCount: number;
}

const FORBIDDEN_HINT =
  /cccd|cmnd|identity|passport|bank|tax|mst|bhxh|insurance|salary|luong|join|probation|position|manager|contract|employment|status/i;

export function validateDecisionFile(
  file: { header: string[]; rows: DecisionRow[] },
  state: ImportState,
  today: string,
): DecisionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const toImport: ImportPlanRow[] = [];
  let skipCount = 0;
  let reviewCount = 0;
  let importRows = 0;

  for (const col of REQUIRED_COLUMNS)
    if (!file.header.includes(col)) errors.push(`Thiếu cột bắt buộc "${col}"`);
  for (const col of file.header) {
    if (ALLOWED.has(col)) continue;
    errors.push(
      FORBIDDEN_HINT.test(col)
        ? `Cột "${col}" không thuộc phạm vi import Employee Core (dữ liệu định danh/việc làm/lương không nhập ở 1.2.4)`
        : `Cột lạ "${col}" — không đoán, hãy bỏ cột này`,
    );
  }
  if (!file.rows.length) errors.push('File không có dòng dữ liệu nào');
  if (errors.length)
    return {
      errors,
      warnings,
      toImport,
      importCount: 0,
      failedCount: 0,
      skipCount: 0,
      reviewCount: 0,
    };

  const seenAccounts = new Map<number, number>();
  const filePhones = new Map<string, number>();
  const fileEmails = new Map<string, number>();

  for (const { line, values: v } of file.rows) {
    const where = `Dòng ${line}${v.accountId ? ` (tài khoản #${v.accountId})` : ''}`;
    const accountId = Number(v.accountId);
    if (!/^\d+$/.test(v.accountId) || !Number.isSafeInteger(accountId)) {
      errors.push(`${where}: accountId không hợp lệ`);
      continue;
    }
    const firstLine = seenAccounts.get(accountId);
    if (firstLine !== undefined) {
      errors.push(`${where}: tài khoản trùng với dòng ${firstLine}`);
      continue;
    }
    seenAccounts.set(accountId, line);

    const decision = v.decision.toUpperCase();
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      errors.push(
        `${where}: decision "${v.decision}" không nhận diện (chỉ IMPORT / SKIP / REVIEW)`,
      );
      continue;
    }
    const account = state.accounts.get(accountId);
    if (decision === 'REVIEW') {
      reviewCount++;
      errors.push(`${where}: còn REVIEW — chưa có quyết định`);
      continue;
    }
    if (decision === 'SKIP') {
      skipCount++;
      if (!account) warnings.push(`${where}: SKIP tài khoản không còn tồn tại`);
      continue;
    }

    // ── IMPORT ──
    importRows++;
    if (!account) {
      errors.push(`${where}: tài khoản không tồn tại`);
      continue;
    }
    const linked = state.linkedAccounts.get(accountId);
    if (linked) {
      errors.push(`${where}: tài khoản đã gắn với hồ sơ ${linked}`);
      continue;
    }
    if (!v.attendanceMode) {
      errors.push(
        `${where}: thiếu attendanceMode (SHIFT / TEACHING_SESSION / UNASSIGNED — chưa chắc thì ghi UNASSIGNED)`,
      );
      continue;
    }

    // Cùng luật với API tạo hồ sơ (DTO) — một nguồn sự thật.
    const raw: Record<string, string> = {};
    for (const k of [
      'fullName',
      'attendanceMode',
      'phone',
      'workEmail',
      'personalEmail',
      'dateOfBirth',
      'gender',
    ])
      if (v[k]) raw[k] = v[k];
    if (raw.attendanceMode)
      raw.attendanceMode = raw.attendanceMode.toUpperCase();
    if (raw.gender) raw.gender = raw.gender.toUpperCase();
    const dto = plainToInstance(CreateHrEmployeeDto, raw);
    const dtoErrors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (dtoErrors.length) {
      for (const e of dtoErrors)
        errors.push(
          `${where}: ${e.property} — ${Object.values(e.constraints ?? {}).join('; ')}`,
        );
      continue;
    }
    if (dto.dateOfBirth && !isValidDateOfBirth(dto.dateOfBirth, today)) {
      errors.push(`${where}: dateOfBirth phải là ngày có thật, 1900 → hôm nay`);
      continue;
    }

    let proposedOrgUnitId: number | null = null;
    if (v.orgUnitCode) {
      const code = v.orgUnitCode.toUpperCase();
      const id = state.activeOrgUnits.get(code);
      if (id === undefined) {
        errors.push(
          `${where}: orgUnitCode "${v.orgUnitCode}" không phải đơn vị đang hoạt động`,
        );
        continue;
      }
      proposedOrgUnitId = id;
    }

    if (!account.isActive)
      warnings.push(
        `${where}: tài khoản đang khoá — hồ sơ tạo với trạng thái INACTIVE`,
      );
    const phone = dto.phone ?? null;
    if (phone) {
      const variants = phoneVariants(phone);
      if (variants.some((p) => state.existingPhones.has(p)))
        warnings.push(`${where}: SĐT đã có ở hồ sơ HR khác (chỉ cảnh báo)`);
      const other = variants.map((p) => filePhones.get(p)).find((x) => x);
      if (other)
        warnings.push(`${where}: SĐT trùng dòng ${other} (chỉ cảnh báo)`);
      filePhones.set(phone, line);
    }
    for (const email of [dto.workEmail, dto.personalEmail]) {
      if (!email) continue;
      if (state.existingEmails.has(email))
        warnings.push(`${where}: email đã có ở hồ sơ HR khác (chỉ cảnh báo)`);
      const other = fileEmails.get(email);
      if (other && other !== line)
        warnings.push(`${where}: email trùng dòng ${other} (chỉ cảnh báo)`);
      fileEmails.set(email, line);
    }

    toImport.push({
      line,
      accountId,
      proposedOrgUnitId,
      input: {
        fullName: dto.fullName,
        accountId,
        status: account.isActive
          ? HrEmployeeStatus.ACTIVE
          : HrEmployeeStatus.INACTIVE,
        attendanceMode: dto.attendanceMode!,
        dateOfBirth: dto.dateOfBirth ?? null,
        gender: dto.gender ?? null,
        phone,
        workEmail: dto.workEmail ?? null,
        personalEmail: dto.personalEmail ?? null,
      },
    });
  }

  // Thứ tự ghi xác định: theo accountId.
  toImport.sort((a, b) => a.accountId - b.accountId);
  return {
    errors,
    warnings,
    toImport,
    importCount: toImport.length,
    failedCount: importRows - toImport.length,
    skipCount,
    reviewCount,
  };
}
