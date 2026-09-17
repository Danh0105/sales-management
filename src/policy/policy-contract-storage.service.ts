import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { PolicyContractArchiveService } from './policy-contract-archive.service';

const PUBLIC_PREFIX = '/uploads/policy-contracts';
const MAX_CONTRACT_BYTES = 20 * 1024 * 1024;

/** Đuôi file cho phép và "chữ ký" (magic bytes) đầu file tương ứng để chống giả mạo mimetype. */
const ALLOWED_TYPES: Record<string, { mimetypes: string[]; signature: Buffer }[]> = {
    '.pdf': [{ mimetypes: ['application/pdf'], signature: Buffer.from('%PDF') }],
    '.jpg': [{ mimetypes: ['image/jpeg'], signature: Buffer.from([0xff, 0xd8, 0xff]) }],
    '.jpeg': [{ mimetypes: ['image/jpeg'], signature: Buffer.from([0xff, 0xd8, 0xff]) }],
    '.png': [{ mimetypes: ['image/png'], signature: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }],
};

@Injectable()
export class PolicyContractStorageService {
    private readonly root = join(process.cwd(), 'uploads', 'policy-contracts');

    constructor(@Optional() private readonly archive?: PolicyContractArchiveService) {}

    async store(file?: Express.Multer.File): Promise<{ url: string; originalName: string }> {
        if (!file) throw new BadRequestException('Vui lòng chọn file hợp đồng (PDF hoặc ảnh)');
        if (file.size > MAX_CONTRACT_BYTES) {
            throw new BadRequestException('File hợp đồng không được vượt quá 20MB');
        }

        // Busboy/multer decode tên file dạng latin1 mặc định, tên tiếng Việt
        // (UTF-8) bị lỗi font ("NGUYá»ŠN"). Giải mã lại đúng UTF-8 trước khi lưu.
        const originalName = Buffer.from(file.originalname || 'contract', 'latin1').toString('utf8');
        const extension = extname(originalName).toLowerCase();
        const rule = ALLOWED_TYPES[extension];
        const matchesSignature = (sig: Buffer) => file.buffer?.subarray(0, sig.length).equals(sig);
        if (!rule || !rule.some((r) => r.mimetypes.includes(file.mimetype) && matchesSignature(r.signature))) {
            throw new BadRequestException('Chỉ hỗ trợ upload file PDF hoặc ảnh (JPG/PNG)');
        }

        await mkdir(this.root, { recursive: true });
        const filename = `${randomUUID()}${extension}`;
        await writeFile(join(this.root, filename), file.buffer);

        // Chuyển ngay lên NAS trong request để không lưu lại file trên VPS.
        // NAS ngắt/quá hạn (breaker) thì cứ để file ở VPS — an toàn hơn là mất
        // dữ liệu; `locate()` vẫn phục vụ được từ tầng nóng cho tới lần sau.
        await this.archive?.archive(filename).catch(() => false);

        return { url: `${PUBLIC_PREFIX}/${filename}`, originalName };
    }

    async remove(url?: string | null): Promise<void> {
        if (!url?.startsWith(`${PUBLIC_PREFIX}/`)) return;
        const filename = url.slice(`${PUBLIC_PREFIX}/`.length);
        if (!filename || filename.includes('/') || filename.includes('\\')) return;

        try {
            await unlink(join(this.root, filename));
        } catch {
            // An old file may already have been removed manually.
        }
        await this.archive?.removeArchived(filename);
    }
}
