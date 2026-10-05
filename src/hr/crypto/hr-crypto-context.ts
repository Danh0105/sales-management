/**
 * Context chuẩn (canonical) cho AAD mã hoá và miền blind index.
 *
 * ĐÂY LÀ HỢP ĐỒNG DỮ LIỆU: ciphertext chỉ giải mã được với đúng chuỗi context
 * đã dùng lúc ghi. Không đổi format / tên field đã có dữ liệu. Cần đổi → thêm
 * version context mới (`hr:v2:...`) và giữ khả năng đọc `v1`.
 *
 *   Mã hoá:       hr:v1:employee:<hr.employees.id>:<field>
 *   Blind index:  hr:v1:bi:<domain>
 *
 * - Gắn `employeeId`: ciphertext của nhân viên A chép sang dòng của B → giải
 *   mã thất bại. `field` khác nhau: chép CCCD sang cột số tài khoản → thất bại.
 * - Không dùng id của dòng (chưa có trước INSERT). Không có `companyId`: hệ
 *   thống một công ty, `hr.employees.id` đã duy nhất toàn cục. Nếu sau này
 *   nhiều công ty có không gian id riêng → context `v2`.
 * - Blind index KHÔNG gắn employee (mục đích là phát hiện trùng GIỮA các nhân
 *   viên) nhưng tách miền theo loại dữ liệu.
 */

export const HR_CRYPTO_CONTEXT_VERSION = 'v1';

export enum HrEncryptedField {
  IDENTITY_NUMBER = 'identity_number',
  BANK_ACCOUNT_NUMBER = 'bank_account_number',
  TAX_NUMBER = 'tax_number',
  SOCIAL_INSURANCE_NUMBER = 'social_insurance_number',
}

export enum HrBlindIndexDomain {
  /** CCCD và CMND 12 số dùng chung số định danh cá nhân → cùng miền. */
  NATIONAL_ID = 'national_id',
  PASSPORT = 'passport',
  WORK_PERMIT = 'work_permit',
  TAX_NUMBER = 'tax_number',
  SOCIAL_INSURANCE_NUMBER = 'social_insurance_number',
  BANK_ACCOUNT = 'bank_account',
}

const FIELDS = new Set<string>(Object.values(HrEncryptedField));
const DOMAINS = new Set<string>(Object.values(HrBlindIndexDomain));

export function employeeFieldContext(
  employeeId: number,
  field: HrEncryptedField,
): string {
  if (!Number.isSafeInteger(employeeId) || employeeId <= 0) {
    throw new Error('employeeId của context mã hoá phải là số nguyên dương');
  }
  if (!FIELDS.has(field)) {
    throw new Error('Field mã hoá không nằm trong danh mục');
  }
  return `hr:${HR_CRYPTO_CONTEXT_VERSION}:employee:${employeeId}:${field}`;
}

export function blindIndexContext(domain: HrBlindIndexDomain): string {
  if (!DOMAINS.has(domain)) {
    throw new Error('Miền blind index không nằm trong danh mục');
  }
  return `hr:${HR_CRYPTO_CONTEXT_VERSION}:bi:${domain}`;
}
