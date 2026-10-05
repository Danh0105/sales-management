/**
 * Nhận diện loại file bằng chữ ký (magic bytes) + tên file hiển thị an toàn.
 *
 * Không tin `Content-Type` client gửi: loại file = chữ ký nội dung; MIME khai
 * báo và đuôi file phải KHỚP chữ ký. Whitelist nhỏ, tự kiểm tra (không kéo
 * thêm thư viện). Giới hạn: chỉ kiểm tra phần đầu file — PDF vẫn có thể chứa
 * script/nội dung độc; cần antivirus (scan_status) để xử lý sau.
 */

export interface AllowedFileType {
  mime: string;
  extensions: string[];
  matches: (head: Buffer) => boolean;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const HR_ALLOWED_FILE_TYPES: readonly AllowedFileType[] = [
  {
    mime: 'application/pdf',
    extensions: ['.pdf'],
    matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    mime: 'image/jpeg',
    extensions: ['.jpg', '.jpeg'],
    matches: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    extensions: ['.png'],
    matches: (b) => b.subarray(0, 8).equals(PNG),
  },
];

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
};

export type FileTypeCheck =
  | { ok: true; mime: string }
  | {
      ok: false;
      reason: 'UNKNOWN_SIGNATURE' | 'MIME_MISMATCH' | 'EXTENSION_MISMATCH';
    };

export function detectAllowedFileType(
  content: Buffer,
  declaredMime: string | undefined,
  displayName: string,
): FileTypeCheck {
  const type = HR_ALLOWED_FILE_TYPES.find((t) => t.matches(content));
  if (!type) return { ok: false, reason: 'UNKNOWN_SIGNATURE' };

  const declared = (declaredMime ?? '').toLowerCase().split(';')[0].trim();
  if ((MIME_ALIASES[declared] ?? declared) !== type.mime) {
    return { ok: false, reason: 'MIME_MISMATCH' };
  }
  const dot = displayName.lastIndexOf('.');
  const ext = dot >= 0 ? displayName.slice(dot).toLowerCase() : '';
  if (!type.extensions.includes(ext)) {
    return { ok: false, reason: 'EXTENSION_MISMATCH' };
  }
  return { ok: true, mime: type.mime };
}

const MAX_NAME = 200;

/**
 * Tên gốc CHỈ để hiển thị — không bao giờ dùng làm đường dẫn. Multer/busboy
 * decode tên dạng latin1 → chuyển lại UTF-8 (tên tiếng Việt). Bỏ thư mục
 * (`/`, `\`), ký tự điều khiển, dấu chấm đầu tên.
 */
export function sanitizeOriginalName(raw: string | undefined): string {
  const input = raw ?? '';
  const utf8 = Buffer.from(input, 'latin1').toString('utf8');
  let name = utf8.includes('�') ? input : utf8;
  name = [...name.normalize('NFC')]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/^[.\s]+/, '').trim();
  if (!name) return 'file';
  if (name.length <= MAX_NAME) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
  return name.slice(0, MAX_NAME - ext.length) + ext;
}

/** Header Content-Disposition an toàn: ASCII fallback + RFC 5987 `filename*`. */
export function contentDisposition(displayName: string): string {
  const ascii =
    displayName.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[.\s]+/, '') ||
    'file';
  const encoded = encodeURIComponent(displayName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
