import { HrPermission } from '../access/hr-permission';
import {
  contentDisposition,
  detectAllowedFileType,
  sanitizeOriginalName,
} from './hr-file-content';
import {
  fileRequiresAccessReason,
  HR_FILE_DOCUMENT_POLICY,
  HrFileClassification,
  HrFileDocumentType,
} from './hr-file-policy';

const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe('detectAllowedFileType — chữ ký nội dung, không tin Content-Type', () => {
  it.each([
    [PDF, 'application/pdf', 'hop-dong.pdf', 'application/pdf'],
    [PNG, 'image/png', 'cccd.PNG', 'image/png'],
    [JPG, 'image/jpeg', 'cccd.jpeg', 'image/jpeg'],
    [JPG, 'image/jpg', 'cccd.jpg', 'image/jpeg'],
  ])('hợp lệ → %#', (content, mime, name, expected) => {
    expect(detectAllowedFileType(content, mime, name)).toEqual({
      ok: true,
      mime: expected,
    });
  });

  it.each([
    ['HTML khai là PDF', HTML, 'application/pdf', 'a.pdf', 'UNKNOWN_SIGNATURE'],
    ['EXE khai là PNG', EXE, 'image/png', 'a.png', 'UNKNOWN_SIGNATURE'],
    ['PDF khai là PNG', PDF, 'image/png', 'a.pdf', 'MIME_MISMATCH'],
    ['PDF đuôi .exe', PDF, 'application/pdf', 'a.exe', 'EXTENSION_MISMATCH'],
    [
      'PDF đuôi .pdf.html',
      PDF,
      'application/pdf',
      'a.pdf.html',
      'EXTENSION_MISMATCH',
    ],
    ['PNG không đuôi', PNG, 'image/png', 'anh', 'EXTENSION_MISMATCH'],
    [
      'file rỗng',
      Buffer.alloc(0),
      'application/pdf',
      'a.pdf',
      'UNKNOWN_SIGNATURE',
    ],
  ])('[3] %s → từ chối', (_l, content, mime, name, reason) => {
    expect(detectAllowedFileType(content, mime, name)).toEqual({
      ok: false,
      reason,
    });
  });
});

describe('sanitizeOriginalName — chỉ để hiển thị', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\secret', 'secret'],
    ['%2e%2e/%2e%2e/x.pdf', 'x.pdf'],
    ['%2e%2e%2fx.pdf', '%2e%2e%2fx.pdf'],
    ['.htaccess', 'htaccess'],
    ['a\u0000b\r\n.pdf', 'ab.pdf'],
    ['', 'file'],
    ['../', 'file'],
  ])('[5/19] %j → %j', (raw, expected) => {
    expect(sanitizeOriginalName(raw)).toBe(expected);
  });

  it('tên tiếng Việt multer decode latin1 → trả lại UTF-8', () => {
    const latin1 = Buffer.from('Căn cước mặt trước.pdf', 'utf8').toString(
      'latin1',
    );
    expect(sanitizeOriginalName(latin1)).toBe('Căn cước mặt trước.pdf');
  });

  it('tên quá dài bị cắt nhưng giữ đuôi', () => {
    const name = sanitizeOriginalName(`${'a'.repeat(300)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('contentDisposition — header an toàn', () => {
  it('ASCII fallback + filename* UTF-8; không để lọt ", CR, LF', () => {
    const h = contentDisposition('Hợp "đồng"\r\nX-Evil: 1.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('attachment; filename="')).toBe(true);
    const ascii = /filename="([^"]*)"/.exec(h)?.[1] ?? '';
    expect(ascii).not.toContain('"');
    expect(h).toContain("filename*=UTF-8''H%E1%BB%A3p");
  });
});

describe('Chính sách loại tài liệu', () => {
  it('[6] mọi loại định danh/ngân hàng/hợp đồng/thuế/BHXH là RESTRICTED', () => {
    for (const t of [
      HrFileDocumentType.IDENTITY_FRONT,
      HrFileDocumentType.IDENTITY_BACK,
      HrFileDocumentType.BANK_PROOF,
      HrFileDocumentType.CONTRACT,
      HrFileDocumentType.TAX,
      HrFileDocumentType.INSURANCE,
    ]) {
      expect(HR_FILE_DOCUMENT_POLICY[t].classification).toBe(
        HrFileClassification.RESTRICTED,
      );
    }
  });

  it('[14] quyền theo loại: CCCD → IDENTITY_REVEAL, ngân hàng → BANK_REVEAL; hợp đồng/thuế/BHXH chưa có quyền → fail closed', () => {
    expect(HR_FILE_DOCUMENT_POLICY.IDENTITY_FRONT.accessPermissions).toEqual([
      HrPermission.IDENTITY_REVEAL,
    ]);
    expect(HR_FILE_DOCUMENT_POLICY.BANK_PROOF.accessPermissions).toEqual([
      HrPermission.BANK_REVEAL,
    ]);
    expect(HR_FILE_DOCUMENT_POLICY.CONTRACT.accessPermissions).toEqual([]);
    expect(HR_FILE_DOCUMENT_POLICY.TAX.accessPermissions).toEqual([]);
    expect(HR_FILE_DOCUMENT_POLICY.INSURANCE.accessPermissions).toEqual([]);
  });

  it('[15] không loại RESTRICTED nào mở bằng EMPLOYEE_VIEW / FILE_VIEW / DOCUMENT_VIEW', () => {
    for (const p of Object.values(HR_FILE_DOCUMENT_POLICY)) {
      if (p.classification === HrFileClassification.RESTRICTED) {
        for (const weak of [
          HrPermission.EMPLOYEE_VIEW,
          HrPermission.FILE_VIEW,
          HrPermission.DOCUMENT_VIEW,
        ])
          expect(p.accessPermissions).not.toContain(weak);
      }
    }
  });

  it('Phase 1.3: loại Documents — phân loại, quyền, chỉ qua module Documents; GENERAL (= OTHER) giữ FILE_VIEW', () => {
    const P = HR_FILE_DOCUMENT_POLICY;
    for (const t of [
      HrFileDocumentType.RESUME,
      HrFileDocumentType.DEGREE,
      HrFileDocumentType.CERTIFICATE,
    ]) {
      expect(P[t].classification).toBe(HrFileClassification.CONFIDENTIAL);
      expect(P[t].accessPermissions).toEqual([HrPermission.DOCUMENT_VIEW]);
      expect(P[t].managedByDocuments).toBe(true);
    }
    expect(P.HEALTH_CERTIFICATE.classification).toBe(
      HrFileClassification.RESTRICTED,
    );
    expect(P.HEALTH_CERTIFICATE.accessPermissions).toEqual([
      HrPermission.HEALTH_DOCUMENT_VIEW,
    ]);
    expect(P.HEALTH_CERTIFICATE.managedByDocuments).toBe(true);
    expect(P.GENERAL.classification).toBe(HrFileClassification.INTERNAL);
    expect(P.GENERAL.accessPermissions).toEqual([
      HrPermission.FILE_VIEW,
      HrPermission.DOCUMENT_VIEW,
    ]);
    expect(P.GENERAL.managedByDocuments).toBe(false);
    for (const t of [
      HrFileDocumentType.IDENTITY_FRONT,
      HrFileDocumentType.IDENTITY_BACK,
      HrFileDocumentType.BANK_PROOF,
    ])
      expect(P[t].managedByDocuments).toBe(false);
  });

  it('tài liệu không phải INTERNAL bắt buộc lý do khi truy cập', () => {
    expect(fileRequiresAccessReason(HrFileClassification.RESTRICTED)).toBe(
      true,
    );
    expect(fileRequiresAccessReason(HrFileClassification.CONFIDENTIAL)).toBe(
      true,
    );
    expect(fileRequiresAccessReason(HrFileClassification.INTERNAL)).toBe(false);
  });
});
