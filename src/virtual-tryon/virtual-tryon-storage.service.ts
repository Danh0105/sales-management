import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import sharp from 'sharp';

import {
  TRYON_MAX_IMAGE_EDGE,
  TRYON_SUPPORTED_MIME,
} from './virtual-tryon.constants';

const PUBLIC_PREFIX = '/uploads/virtual-tryon';

const storageError = (status: HttpStatus, code: string, message: string) =>
  new HttpException({ statusCode: status, code, message }, status);

/**
 * Lưu ảnh đầu vào/kết quả của thử đồ ảo xuống đĩa và trả về URL công khai.
 *
 * Tách khỏi service gọi mô hình để phần lưu trữ test được mà không cần API key,
 * giống cách `TimetableExtractService` tách khâu gọi mô hình khỏi khâu ghi dữ
 * liệu.
 */
@Injectable()
export class VirtualTryOnStorageService {
  private readonly logger = new Logger(VirtualTryOnStorageService.name);
  private readonly directory: string;

  constructor(private readonly config: ConfigService) {
    this.directory = resolve(
      config.get('VIRTUAL_TRYON_UPLOAD_DIR') ||
        join(process.cwd(), 'uploads', 'virtual-tryon'),
    );
  }

  /**
   * Chuẩn hoá ảnh người dùng tải lên: kiểm định dạng thật (theo nội dung file
   * chứ không tin `mimetype` do client khai), co cạnh dài và chuyển sang webp
   * cho nhẹ. Trả về URL công khai.
   */
  async storeUpload(file: Express.Multer.File, kind: string): Promise<string> {
    if (!file?.buffer?.length) {
      throw storageError(
        HttpStatus.BAD_REQUEST,
        'TRYON_IMAGE_EMPTY',
        `Thiếu ảnh ${kind}`,
      );
    }

    let image: sharp.Sharp;
    let metadata: sharp.Metadata;
    try {
      image = sharp(file.buffer, { failOn: 'none' });
      metadata = await image.metadata();
    } catch {
      throw storageError(
        HttpStatus.BAD_REQUEST,
        'TRYON_IMAGE_INVALID',
        `Ảnh ${kind} không đọc được, vui lòng chọn ảnh khác`,
      );
    }

    const detected = metadata.format ? `image/${metadata.format}` : '';
    if (!TRYON_SUPPORTED_MIME.includes(detected as any)) {
      throw storageError(
        HttpStatus.BAD_REQUEST,
        'TRYON_IMAGE_UNSUPPORTED',
        `Ảnh ${kind} phải là JPEG, PNG hoặc WEBP`,
      );
    }

    const buffer = await image
      .rotate() // tôn trọng EXIF orientation, không thì ảnh điện thoại bị xoay
      .resize({
        width: TRYON_MAX_IMAGE_EDGE,
        height: TRYON_MAX_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 90 })
      .toBuffer();

    return this.write(buffer, `${kind}-${randomUUID()}.webp`);
  }

  /** Ảnh mô hình trả về (base64 PNG) — giữ nguyên PNG, không nén lại. */
  async storeResult(base64: string): Promise<string> {
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      throw storageError(
        HttpStatus.BAD_GATEWAY,
        'TRYON_RESULT_EMPTY',
        'Mô hình không trả về ảnh',
      );
    }
    return this.write(buffer, `result-${randomUUID()}.png`);
  }

  /** Đọc lại ảnh đã lưu để gửi cho mô hình. */
  async read(url: string): Promise<Buffer> {
    return readFile(this.resolvePath(url));
  }

  async remove(url?: string | null): Promise<void> {
    if (!url) return;
    try {
      await unlink(this.resolvePath(url));
    } catch (error) {
      // Dọn rác không thành công không được làm hỏng luồng chính.
      this.logger.warn(`Không xoá được ảnh ${url}: ${(error as Error).message}`);
    }
  }

  /** Ghép `PUBLIC_BASE_URL` khi có, giống cách ảnh báo giảng đang trả về. */
  publicUrl(url?: string | null): string | null {
    if (!url) return null;
    const base = (this.config.get<string>('PUBLIC_BASE_URL') || '').replace(
      /\/$/,
      '',
    );
    return base && url.startsWith('/') ? `${base}${url}` : url;
  }

  private async write(buffer: Buffer, filename: string): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(join(this.directory, filename), buffer);
    return `${PUBLIC_PREFIX}/${filename}`;
  }

  /**
   * Chặn path traversal: chỉ nhận đúng tiền tố công khai và tên file phẳng,
   * rồi kiểm tra lại đường dẫn tuyệt đối vẫn nằm trong thư mục lưu trữ.
   */
  private resolvePath(url: string): string {
    const filename = url.startsWith(`${PUBLIC_PREFIX}/`)
      ? url.slice(PUBLIC_PREFIX.length + 1)
      : '';

    if (!filename || filename.includes('/') || filename.includes('\\')) {
      throw storageError(
        HttpStatus.BAD_REQUEST,
        'TRYON_IMAGE_PATH_INVALID',
        'Đường dẫn ảnh không hợp lệ',
      );
    }

    const full = resolve(this.directory, filename);
    if (!full.startsWith(this.directory + sep)) {
      throw storageError(
        HttpStatus.BAD_REQUEST,
        'TRYON_IMAGE_PATH_INVALID',
        'Đường dẫn ảnh không hợp lệ',
      );
    }
    return full;
  }
}
