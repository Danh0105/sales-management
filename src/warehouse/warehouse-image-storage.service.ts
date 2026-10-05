import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';

const PUBLIC_PREFIX = '/uploads/warehouse-items';
export const MAX_WAREHOUSE_IMAGE_BYTES = 10 * 1024 * 1024;

/** Nhận diện định dạng ảnh bằng magic bytes — không tin mimetype client gửi. */
const detectImageExtension = (buffer?: Buffer): string | null => {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'png';
    }
    if (
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 'webp';
    }
    return null;
};

@Injectable()
export class WarehouseImageStorageService {
    private readonly root = join(process.cwd(), 'uploads', 'warehouse-items');

    async store(file?: Express.Multer.File): Promise<string> {
        if (!file) {
            throw new BadRequestException('Vui lòng chụp hoặc chọn ảnh thiết bị');
        }
        if (file.size > MAX_WAREHOUSE_IMAGE_BYTES) {
            throw new BadRequestException('Ảnh thiết bị không được vượt quá 10MB');
        }

        const extension = detectImageExtension(file.buffer);
        if (!extension) {
            throw new BadRequestException('Chỉ hỗ trợ ảnh JPG, PNG hoặc WEBP');
        }

        await mkdir(this.root, { recursive: true });

        const filename = `${randomUUID()}.${extension}`;
        await writeFile(join(this.root, filename), file.buffer);

        return `${PUBLIC_PREFIX}/${filename}`;
    }

    async remove(url?: string | null): Promise<void> {
        if (!url?.startsWith(`${PUBLIC_PREFIX}/`)) return;

        const filename = url.slice(`${PUBLIC_PREFIX}/`.length);
        if (!filename || filename.includes('/') || filename.includes('\\')) return;

        try {
            await unlink(join(this.root, filename));
        } catch {
            // File có thể đã bị xóa thủ công; không chặn luồng nghiệp vụ.
        }
    }
}
