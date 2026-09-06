import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import sharp from 'sharp';
import {
  LessonImage,
  LessonImageResponse,
  StoredLessonImage,
} from './lesson-image.type';

export type { LessonImage, StoredLessonImage };

/** @deprecated dùng `LessonImage`. */
export type LessonImageItem = LessonImage;

const STORED_MIME_TYPE = 'image/webp';

const imageError = (status: HttpStatus, code: string, message: string) =>
  new HttpException({ statusCode: status, code, message }, status);

@Injectable()
export class LessonImageStorageService {
  private readonly directory: string;

  constructor(private readonly config: ConfigService) {
    this.directory = resolve(
      config.get('LESSON_IMAGE_UPLOAD_DIR') ||
        join(process.cwd(), 'uploads', 'lesson-images'),
    );
  }

  /** Lưu cả lô; một ảnh hỏng là dọn sạch những ảnh đã ghi trước đó. */
  async storeMany(files: Express.Multer.File[]): Promise<LessonImage[]> {
    const stored: LessonImage[] = [];
    try {
      for (const [index, file] of files.entries()) {
        stored.push(await this.store(file, index));
      }
      return stored;
    } catch (error) {
      await this.removeMany(stored);
      throw error;
    }
  }

  async removeMany(images: { url: string }[]): Promise<void> {
    await Promise.all(images.map((image) => this.remove(image.url)));
  }

  /**
   * Chuẩn hoá ảnh đọc từ database trước khi trả cho client: bù metadata cho
   * bản ghi cũ (chỉ có `url` + `name`) và ghép `PUBLIC_BASE_URL` nếu có.
   */
  publicItems(images?: StoredLessonImage[] | null): LessonImageResponse[] {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') || '').replace(
      /\/$/,
      '',
    );
    return (images ?? []).map((image, index) => {
      const video = image.mimeType?.startsWith('video/');
      return {
        id: index + 1,
        url:
          base && image.url.startsWith('/') ? `${base}${image.url}` : image.url,
        ...(video ? { mimeType: image.mimeType, mediaType: 'video' as const } : {}),
      };
    });
  }

  private async store(
    file: Express.Multer.File,
    sortOrder: number,
  ): Promise<LessonImage> {
    const videoExtension = this.detectVideoExtension(file);
    if (videoExtension) {
      const id = randomUUID();
      const name = `${id}.${videoExtension}`;
      try {
        await mkdir(this.directory, { recursive: true });
        await writeFile(join(this.directory, name), file.buffer, { flag: 'wx' });
      } catch {
        throw imageError(
          HttpStatus.BAD_GATEWAY,
          'LESSON_MEDIA_STORAGE_ERROR',
          'Không thể lưu minh chứng báo giảng',
        );
      }
      return {
        id,
        url: `/uploads/lesson-images/${name}`,
        name,
        mimeType: file.mimetype,
        size: file.buffer.byteLength,
        sortOrder,
      };
    }

    if (!this.detectFormat(file.buffer)) {
      throw imageError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'LESSON_IMAGE_TYPE_UNSUPPORTED',
        'Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc video MP4, MOV, WebM',
      );
    }

    let output: Buffer;
    try {
      const image = sharp(file.buffer, {
        failOn: 'error',
        limitInputPixels: 40_000_000,
      });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        !['jpeg', 'png', 'webp'].includes(metadata.format || '')
      ) {
        throw new Error('invalid image');
      }
      output = await image.rotate().webp({ quality: 85 }).toBuffer();
    } catch {
      throw imageError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'LESSON_IMAGE_INVALID',
        'Ảnh bị hỏng hoặc không thể xử lý',
      );
    }

    const id = randomUUID();
    const name = `${id}.webp`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(join(this.directory, name), output, { flag: 'wx' });
    } catch {
      throw imageError(
        HttpStatus.BAD_GATEWAY,
        'LESSON_IMAGE_STORAGE_ERROR',
        'Không thể lưu ảnh bài dạy',
      );
    }
    return {
      id,
      url: `/uploads/lesson-images/${name}`,
      name,
      mimeType: STORED_MIME_TYPE,
      size: output.byteLength,
      sortOrder,
    };
  }

  private async remove(url: string): Promise<void> {
    if (!url.startsWith('/uploads/lesson-images/')) return;
    const name = url.slice('/uploads/lesson-images/'.length);
    if (!/^[0-9a-f-]{36}\.(webp|mp4|mov|webm)$/i.test(name)) return;
    const target = resolve(this.directory, name);
    if (!target.startsWith(`${this.directory}${sep}`)) return;
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private detectFormat(buffer: Buffer): boolean {
    return (
      (buffer.length >= 3 &&
        buffer[0] === 0xff &&
        buffer[1] === 0xd8 &&
        buffer[2] === 0xff) ||
      (buffer.length >= 8 &&
        buffer
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (buffer.length >= 12 &&
        buffer.toString('ascii', 0, 4) === 'RIFF' &&
        buffer.toString('ascii', 8, 12) === 'WEBP')
    );
  }

  private detectVideoExtension(file: Express.Multer.File): string | null {
    const mimeToExtension: Record<string, string> = {
      'video/mp4': 'mp4',
      'video/quicktime': 'mov',
      'video/webm': 'webm',
    };
    const extension = mimeToExtension[file.mimetype];
    if (!extension) return null;

    const buffer = file.buffer;
    const isMp4OrMov =
      (extension === 'mp4' || extension === 'mov') &&
      buffer.length >= 12 &&
      buffer.toString('ascii', 4, 8) === 'ftyp';
    const isWebm =
      extension === 'webm' &&
      buffer.length >= 4 &&
      buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    return isMp4OrMov || isWebm ? extension : null;
  }
}
