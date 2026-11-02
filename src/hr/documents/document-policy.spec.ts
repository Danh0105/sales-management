import {
  HR_FILE_DOCUMENT_POLICY,
  HrFileClassification,
  HrFileDocumentType,
} from '../files/hr-file-policy';
import { HrPermission } from '../access/hr-permission';
import {
  DOCUMENT_POLICY,
  DOCUMENT_TYPES,
  documentDateProblems,
  documentTypeOfFile,
  expiryStatus,
} from './document-policy';

const TODAY = '2026-10-05';

describe('document-policy — loại tài liệu', () => {
  it('5 loại, mỗi loại trỏ tới một loại file 0.4C (phân loại/quyền một nguồn)', () => {
    expect([...DOCUMENT_TYPES]).toEqual([
      'RESUME',
      'DEGREE',
      'CERTIFICATE',
      'HEALTH_CERTIFICATE',
      'OTHER',
    ]);
    const file = (t: (typeof DOCUMENT_TYPES)[number]) =>
      HR_FILE_DOCUMENT_POLICY[DOCUMENT_POLICY[t].fileType];
    expect(file('RESUME').classification).toBe(
      HrFileClassification.CONFIDENTIAL,
    );
    expect(file('HEALTH_CERTIFICATE').classification).toBe(
      HrFileClassification.RESTRICTED,
    );
    expect(file('HEALTH_CERTIFICATE').accessPermissions).toEqual([
      HrPermission.HEALTH_DOCUMENT_VIEW,
    ]);
    expect(file('OTHER').classification).toBe(HrFileClassification.INTERNAL);
  });

  it('OTHER dùng loại file GENERAL có sẵn (gộp logic, không đổi dữ liệu); không có lý lịch tư pháp', () => {
    expect(DOCUMENT_POLICY.OTHER.fileType).toBe(HrFileDocumentType.GENERAL);
    expect(documentTypeOfFile(HrFileDocumentType.GENERAL)).toBe('OTHER');
    expect(documentTypeOfFile(HrFileDocumentType.IDENTITY_FRONT)).toBeNull();
    expect(DOCUMENT_TYPES.some((t) => /CRIMINAL/.test(t))).toBe(false);
  });
});

describe('expiryStatus — theo ngày Việt Nam', () => {
  it.each([
    [null, 'NO_EXPIRY'],
    ['2026-10-04', 'EXPIRED'],
    ['2026-10-05', 'EXPIRING'],
    ['2026-11-04', 'EXPIRING'],
    ['2026-11-05', 'VALID'],
  ] as const)('%s → %s', (expiresOn, expected) => {
    expect(expiryStatus(expiresOn, TODAY)).toBe(expected);
  });

  it('ngưỡng tuỳ chỉnh; qua năm không lệch', () => {
    expect(expiryStatus('2026-10-12', TODAY, 7)).toBe('EXPIRING');
    expect(expiryStatus('2026-10-13', TODAY, 7)).toBe('VALID');
    expect(expiryStatus('2027-01-03', '2026-12-04')).toBe('EXPIRING');
  });
});

describe('documentDateProblems', () => {
  const none = { issuedOn: null, expiresOn: null };

  it('loại không có hạn (lý lịch, bằng cấp) mà gửi ngày hết hạn → lỗi', () => {
    expect(
      documentDateProblems(
        'DEGREE',
        { ...none, expiresOn: '2030-01-01' },
        TODAY,
      ),
    ).toEqual(['Bằng cấp không có ngày hết hạn']);
    expect(documentDateProblems('RESUME', none, TODAY)).toEqual([]);
  });

  it('giấy khám sức khỏe bắt buộc có ngày hết hạn; chứng chỉ/khác tuỳ chọn', () => {
    expect(documentDateProblems('HEALTH_CERTIFICATE', none, TODAY)).toEqual([
      'Giấy khám sức khỏe bắt buộc có ngày hết hạn',
    ]);
    expect(
      documentDateProblems(
        'HEALTH_CERTIFICATE',
        { issuedOn: '2026-09-01', expiresOn: '2027-09-01' },
        TODAY,
      ),
    ).toEqual([]);
    expect(documentDateProblems('CERTIFICATE', none, TODAY)).toEqual([]);
    expect(documentDateProblems('OTHER', none, TODAY)).toEqual([]);
  });

  it('ngày cấp ở tương lai / sau ngày hết hạn → lỗi; được phép đã hết hạn (lưu lịch sử)', () => {
    expect(
      documentDateProblems(
        'CERTIFICATE',
        { issuedOn: '2026-10-06', expiresOn: null },
        TODAY,
      ),
    ).toEqual(['Ngày cấp không được ở tương lai']);
    expect(
      documentDateProblems(
        'CERTIFICATE',
        { issuedOn: '2026-01-02', expiresOn: '2026-01-01' },
        TODAY,
      ),
    ).toEqual(['Ngày hết hạn phải sau hoặc bằng ngày cấp']);
    expect(
      documentDateProblems(
        'HEALTH_CERTIFICATE',
        { issuedOn: '2024-01-01', expiresOn: '2025-01-01' },
        TODAY,
      ),
    ).toEqual([]);
  });
});
