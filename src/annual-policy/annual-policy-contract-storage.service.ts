import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { extname, join } from 'path';

const PUBLIC_PREFIX = '/uploads/annual-policy-contracts';
const MAX_CONTRACT_BYTES = 20 * 1024 * 1024;

@Injectable()
export class AnnualPolicyContractStorageService {
    private readonly root = join(process.cwd(), 'uploads', 'annual-policy-contracts');

    async store(file?: Express.Multer.File): Promise<{ url: string; originalName: string }> {
        if (!file) {
            throw new BadRequestException('Vui lòng chọn file hợp đồng PDF');
        }

        if (file.size > MAX_CONTRACT_BYTES) {
            throw new BadRequestException('File hợp đồng không được vượt quá 20MB');
        }

        const originalName = file.originalname || 'contract.pdf';
        const extension = extname(originalName).toLowerCase();
        const looksLikePdf =
            file.mimetype === 'application/pdf' ||
            extension === '.pdf' ||
            file.buffer?.subarray(0, 4).toString() === '%PDF';

        if (!looksLikePdf || file.buffer?.subarray(0, 4).toString() !== '%PDF') {
            throw new BadRequestException('Chỉ hỗ trợ upload file PDF hợp đồng');
        }

        await mkdir(this.root, { recursive: true });

        const filename = `${randomUUID()}.pdf`;
        await writeFile(join(this.root, filename), file.buffer);

        return {
            url: `${PUBLIC_PREFIX}/${filename}`,
            originalName,
        };
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
