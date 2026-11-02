import { addDays } from '../access-admin/hr-grant-policy';
import { HrFileDocumentType } from '../files/hr-file-policy';

/**
 * Hồ sơ tài liệu nhân viên (Phase 1.3) — luật nghiệp vụ. Thuần, test đầy đủ.
 *
 * Phân loại và quyền xem NỘI DUNG không định nghĩa lại ở đây: mỗi loại tài
 * liệu trỏ tới một loại file của 0.4C (`HR_FILE_DOCUMENT_POLICY`) — một nguồn
 * sự thật. `OTHER` dùng loại file `GENERAL` có sẵn (gộp logic, không đổi dữ liệu).
 */
export const DOCUMENT_TYPES = [
  'RESUME',
  'DEGREE',
  'CERTIFICATE',
  'HEALTH_CERTIFICATE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** NONE: không có hạn (gửi expiresOn → lỗi); OPTIONAL; REQUIRED. */
export type ExpiryRule = 'NONE' | 'OPTIONAL' | 'REQUIRED';

export interface DocumentTypePolicy {
  fileType: HrFileDocumentType;
  expiry: ExpiryRule;
  label: string;
}

export const DOCUMENT_POLICY: Record<DocumentType, DocumentTypePolicy> = {
  RESUME: {
    fileType: HrFileDocumentType.RESUME,
    expiry: 'NONE',
    label: 'Sơ yếu lý lịch',
  },
  DEGREE: {
    fileType: HrFileDocumentType.DEGREE,
    expiry: 'NONE',
    label: 'Bằng cấp',
  },
  CERTIFICATE: {
    fileType: HrFileDocumentType.CERTIFICATE,
    expiry: 'OPTIONAL',
    label: 'Chứng chỉ',
  },
  HEALTH_CERTIFICATE: {
    fileType: HrFileDocumentType.HEALTH_CERTIFICATE,
    expiry: 'REQUIRED',
    label: 'Giấy khám sức khỏe',
  },
  OTHER: {
    fileType: HrFileDocumentType.GENERAL,
    expiry: 'OPTIONAL',
    label: 'Tài liệu khác',
  },
};

/** Loại file của 0.4C → loại tài liệu (GENERAL hiển thị là OTHER). */
export function documentTypeOfFile(
  fileType: HrFileDocumentType,
): DocumentType | null {
  const hit = DOCUMENT_TYPES.find(
    (t) => DOCUMENT_POLICY[t].fileType === fileType,
  );
  return hit ?? null;
}

// ─── Hạn ───────────────────────────────────────────────────────────────

/** Còn ≤ số ngày này (tính cả hôm nay → ngày hết hạn) → "sắp hết hạn". */
export const EXPIRING_WITHIN_DAYS = 30;

export type ExpiryStatus = 'NO_EXPIRY' | 'VALID' | 'EXPIRING' | 'EXPIRED';

/**
 * Trạng thái hạn theo ngày Việt Nam (`today` = hrToday()). `expiresOn` là ngày
 * CUỐI còn hiệu lực: hôm nay = expiresOn → còn hạn (EXPIRING); hôm sau → EXPIRED.
 */
export function expiryStatus(
  expiresOn: string | null,
  today: string,
  withinDays = EXPIRING_WITHIN_DAYS,
): ExpiryStatus {
  if (!expiresOn) return 'NO_EXPIRY';
  if (expiresOn < today) return 'EXPIRED';
  if (expiresOn <= addDays(today, withinDays)) return 'EXPIRING';
  return 'VALID';
}

// ─── Kiểm tra metadata ────────────────────────────────────────────────

export interface DocumentDates {
  issuedOn: string | null;
  expiresOn: string | null;
}

/** Lỗi metadata theo loại (câu tiếng Việt) — rỗng = hợp lệ. */
export function documentDateProblems(
  type: DocumentType,
  dates: DocumentDates,
  today: string,
): string[] {
  const out: string[] = [];
  const rule = DOCUMENT_POLICY[type].expiry;
  if (rule === 'NONE' && dates.expiresOn)
    out.push(`${DOCUMENT_POLICY[type].label} không có ngày hết hạn`);
  if (rule === 'REQUIRED' && !dates.expiresOn)
    out.push(`${DOCUMENT_POLICY[type].label} bắt buộc có ngày hết hạn`);
  if (dates.issuedOn && dates.issuedOn > today)
    out.push('Ngày cấp không được ở tương lai');
  if (dates.issuedOn && dates.expiresOn && dates.issuedOn > dates.expiresOn)
    out.push('Ngày hết hạn phải sau hoặc bằng ngày cấp');
  return out;
}
