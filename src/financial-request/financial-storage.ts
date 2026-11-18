import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync, promises as fs } from 'fs';
import { extname, join, normalize, resolve, sep } from 'path';

import { ATTACHMENT_MAX_BYTES } from './financial-request.constants';

/**
 * Kho tệp riêng của phân hệ tài chính — KHÔNG nằm dưới `/uploads` (thư mục
 * đó được phục vụ công khai không cần đăng nhập). Tệp chỉ đọc được qua API có
 * kiểm tra quyền. Đổi vị trí bằng `FINANCIAL_STORAGE_DIR`.
 */
export function storageRoot(): string {
  return resolve(
    process.env.FINANCIAL_STORAGE_DIR ||
      join(process.cwd(), 'private-uploads', 'financial'),
  );
}

interface FileRule {
  mimes: string[];
  /** Chữ ký đầu tệp (magic bytes); null = tệp văn phòng dạng zip/ole. */
  signatures: number[][];
}

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

const RULES: Record<string, FileRule> = {
  '.pdf': {
    mimes: ['application/pdf'],
    signatures: [[0x25, 0x50, 0x44, 0x46]],
  },
  '.jpg': { mimes: ['image/jpeg'], signatures: [[0xff, 0xd8, 0xff]] },
  '.jpeg': { mimes: ['image/jpeg'], signatures: [[0xff, 0xd8, 0xff]] },
  '.png': {
    mimes: ['image/png'],
    signatures: [[0x89, 0x50, 0x4e, 0x47]],
  },
  '.webp': { mimes: ['image/webp'], signatures: [[0x52, 0x49, 0x46, 0x46]] },
  '.xlsx': {
    mimes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    signatures: [ZIP],
  },
  '.xls': { mimes: ['application/vnd.ms-excel'], signatures: [OLE] },
  '.docx': {
    mimes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    signatures: [ZIP],
  },
  '.doc': { mimes: ['application/msword'], signatures: [OLE] },
};

export const ALLOWED_EXTENSIONS = Object.keys(RULES);

export interface StoredFile {
  storagePath: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** Tên gốc từ multer là latin1 — đổi về UTF-8 để giữ dấu tiếng Việt. */
export function decodeOriginalName(name: string): string {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

export function validateUpload(file: Express.Multer.File): {
  ext: string;
  mime: string;
} {
  if (!file?.buffer?.length) {
    throw new BadRequestException('Tệp rỗng');
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new BadRequestException(
      `Tệp "${decodeOriginalName(file.originalname)}" vượt quá ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB`,
    );
  }
  const ext = extname(file.originalname || '').toLowerCase();
  const rule = RULES[ext];
  if (!rule) {
    throw new BadRequestException(
      `Chỉ nhận tệp ${ALLOWED_EXTENSIONS.join(', ')}`,
    );
  }
  const head = file.buffer.subarray(0, 8);
  const signatureOk = rule.signatures.some((signature) =>
    signature.every((byte, index) => head[index] === byte),
  );
  if (!signatureOk) {
    throw new BadRequestException(
      `Nội dung tệp "${decodeOriginalName(file.originalname)}" không khớp định dạng ${ext}`,
    );
  }
  return { ext, mime: rule.mimes[0] };
}

/** Ghi tệp đã kiểm tra vào kho: <root>/<yyyy>/<mm>/<uuid><ext>. */
export async function storeFile(
  file: Express.Multer.File,
  folder: string,
): Promise<StoredFile> {
  const { ext, mime } = validateUpload(file);
  const now = new Date();
  const relativeDir = join(
    folder,
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
  );
  const absoluteDir = join(storageRoot(), relativeDir);
  await fs.mkdir(absoluteDir, { recursive: true, mode: 0o750 });
  const name = `${randomUUID()}${ext}`;
  await fs.writeFile(join(absoluteDir, name), file.buffer, { mode: 0o640 });
  return {
    storagePath: join(relativeDir, name),
    originalName: decodeOriginalName(file.originalname).slice(0, 255),
    mimeType: mime,
    sizeBytes: file.size,
    sha256: createHash('sha256').update(file.buffer).digest('hex'),
  };
}

/** Đường dẫn tuyệt đối an toàn (chặn `..` thoát khỏi kho). */
export function absolutePath(storagePath: string): string {
  const root = storageRoot();
  const full = resolve(root, normalize(storagePath));
  if (!full.startsWith(root + sep)) {
    throw new NotFoundException('Không tìm thấy tệp');
  }
  return full;
}

export function openStoredFile(storagePath: string) {
  const full = absolutePath(storagePath);
  if (!existsSync(full))
    throw new NotFoundException('Tệp không còn trên máy chủ');
  return createReadStream(full);
}

export async function readStoredFile(storagePath: string): Promise<Buffer> {
  const full = absolutePath(storagePath);
  return fs.readFile(full);
}

/** Header Content-Disposition có tên tiếng Việt (RFC 5987). */
export function contentDisposition(
  fileName: string,
  disposition: 'inline' | 'attachment' = 'inline',
): string {
  const ascii = fileName
    .normalize('NFD')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/"/g, '');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
