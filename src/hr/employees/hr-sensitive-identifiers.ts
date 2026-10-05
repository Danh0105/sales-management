import { BadRequestException } from '@nestjs/common';
import { normalizeIdentifier } from '../crypto/hr-blind-index.service';
import {
  HrBlindIndexDomain,
  HrEncryptedField,
} from '../crypto/hr-crypto-context';
import { HrIdentityDocumentType } from './entities/hr-employee-identity-document.entity';

/**
 * Luật định dạng từng loại số định danh — nơi DUY NHẤT, đổi quy định thì sửa ở
 * đây. Chỉ kiểm tra hình thức (độ dài, ký tự), không kiểm tra checksum.
 *
 * Mọi loại tối thiểu 6 ký tự: `last4` không bao giờ là toàn bộ giá trị.
 */
export type HrIdentifierKind =
  | HrIdentityDocumentType
  | 'TAX_NUMBER'
  | 'SOCIAL_INSURANCE_NUMBER'
  | 'BANK_ACCOUNT';

interface IdentifierRule {
  pattern: RegExp;
  /** Mô tả lỗi — KHÔNG chứa giá trị người dùng nhập. */
  message: string;
  field: HrEncryptedField;
  domain: HrBlindIndexDomain;
}

const RULES: Record<HrIdentifierKind, IdentifierRule> = {
  CCCD: {
    pattern: /^\d{12}$/,
    message: 'Số CCCD phải gồm 12 chữ số.',
    field: HrEncryptedField.IDENTITY_NUMBER,
    domain: HrBlindIndexDomain.NATIONAL_ID,
  },
  CMND: {
    pattern: /^(\d{9}|\d{12})$/,
    message: 'Số CMND phải gồm 9 hoặc 12 chữ số.',
    field: HrEncryptedField.IDENTITY_NUMBER,
    domain: HrBlindIndexDomain.NATIONAL_ID,
  },
  PASSPORT: {
    pattern: /^[A-Z0-9]{6,20}$/,
    message: 'Số hộ chiếu gồm 6–20 chữ cái/chữ số.',
    field: HrEncryptedField.IDENTITY_NUMBER,
    domain: HrBlindIndexDomain.PASSPORT,
  },
  WORK_PERMIT: {
    pattern: /^[A-Z0-9]{6,30}$/,
    message: 'Số giấy phép lao động gồm 6–30 chữ cái/chữ số.',
    field: HrEncryptedField.IDENTITY_NUMBER,
    domain: HrBlindIndexDomain.WORK_PERMIT,
  },
  TAX_NUMBER: {
    // 10 số, 13 số (10 + 3 đơn vị phụ thuộc, dấu `-` được bỏ khi chuẩn hoá),
    // hoặc 12 số (số định danh cá nhân dùng làm MST).
    pattern: /^(\d{10}|\d{12}|\d{13})$/,
    message: 'Mã số thuế phải gồm 10, 12 hoặc 13 chữ số.',
    field: HrEncryptedField.TAX_NUMBER,
    domain: HrBlindIndexDomain.TAX_NUMBER,
  },
  SOCIAL_INSURANCE_NUMBER: {
    pattern: /^\d{10}$/,
    message: 'Mã số BHXH phải gồm 10 chữ số.',
    field: HrEncryptedField.SOCIAL_INSURANCE_NUMBER,
    domain: HrBlindIndexDomain.SOCIAL_INSURANCE_NUMBER,
  },
  BANK_ACCOUNT: {
    pattern: /^[A-Z0-9]{6,30}$/,
    message: 'Số tài khoản gồm 6–30 chữ cái/chữ số.',
    field: HrEncryptedField.BANK_ACCOUNT_NUMBER,
    domain: HrBlindIndexDomain.BANK_ACCOUNT,
  },
};

export interface PreparedIdentifier {
  kind: HrIdentifierKind;
  /** Giá trị đã chuẩn hoá — CHỈ giữ trong bộ nhớ để mã hoá/băm. */
  value: string;
  last4: string;
  field: HrEncryptedField;
  domain: HrBlindIndexDomain;
}

/** Chuẩn hoá → kiểm tra định dạng. Lỗi 400 không kèm giá trị. */
export function prepareIdentifier(
  kind: HrIdentifierKind,
  raw: unknown,
  fieldName: string,
): PreparedIdentifier {
  const rule = RULES[kind];
  const value = typeof raw === 'string' ? normalizeIdentifier(raw) : '';
  if (!rule || !rule.pattern.test(value)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'HR_IDENTIFIER_INVALID',
      field: fieldName,
      message: rule?.message ?? 'Loại định danh không hợp lệ.',
    });
  }
  return {
    kind,
    value,
    last4: value.slice(-4),
    field: rule.field,
    domain: rule.domain,
  };
}

/** Dạng che từ `last4` — không cần giải mã. */
export function maskedFromLast4(last4: string | null | undefined) {
  return last4 ? `********${last4}` : null;
}
