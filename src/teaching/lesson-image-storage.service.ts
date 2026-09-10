import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { access, mkdir, rmdir, unlink, writeFile } from 'fs/promises';
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
  private readonly logger = new Logger(LessonImageStorageService.name);
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

  publicUrl(url: string): string {
    const base = (this.config.get<string>('PUBLIC_BASE_URL') || '').replace(/\/$/, '');
    return base && url.startsWith('/') ? `${base}${url}` : url;
  }

  /** Tạo thumbnail cho dữ liệu cũ theo nhu cầu, tối đa 30 file mỗi request. */
  async ensureThumbnail(url: string, storedUrl?: string | null): Promise<string> {
    const fallback = this.thumbnailUrlOf(url);
    const thumbnailUrl = storedUrl || fallback;
    if (!url.startsWith('/uploads/lesson-images/') || !fallback) {
      throw imageError(HttpStatus.UNPROCESSABLE_ENTITY, 'LESSON_THUMBNAIL_UNAVAILABLE', 'Không thể tạo ảnh thu nhỏ');
    }
    const name = url.slice('/uploads/lesson-images/'.length);
    const source = resolve(this.directory, name);
    const targetName = fallback.slice('/uploads/lesson-images/thumb/'.length);
    const target = resolve(this.directory, 'thumb', targetName);
    try {
      await access(target);
    } catch {
      await mkdir(resolve(this.directory, 'thumb'), { recursive: true });
      await sharp(source, { failOn: 'none' })
        .rotate()
        .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 76 })
        .toFile(target);
    }
    return this.publicUrl(thumbnailUrl);
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

    const output = await this.toWebp(file);

    const thumbnail = await sharp(output)
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76 })
      .toBuffer();

    const id = randomUUID();
    const name = `${id}.webp`;
    try {
      await mkdir(this.directory, { recursive: true });
      await mkdir(join(this.directory, 'thumb'), { recursive: true });
      await writeFile(join(this.directory, name), output, { flag: 'wx' });
      await writeFile(join(this.directory, 'thumb', name), thumbnail, { flag: 'wx' });
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
      thumbnailUrl: `/uploads/lesson-images/thumb/${name}`,
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
    const thumbnail = resolve(this.directory, 'thumb', name.replace(/\.[^.]+$/, '.webp'));
    await unlink(thumbnail).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rmdir(resolve(this.directory, 'thumb')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
      },
    );
  }

  private thumbnailUrlOf(url: string): string {
    if (!url.startsWith('/uploads/lesson-images/')) return '';
    const name = url.slice('/uploads/lesson-images/'.length);
    if (!/^[0-9a-f-]{36}\.(webp|jpe?g|png)$/i.test(name)) return '';
    return `/uploads/lesson-images/thumb/${name.replace(/\.[^.]+$/, '.webp')}`;
  }

  /**
   * Giải mã ảnh sang WebP, chịu lỗi hai tầng.
   *
   * Ảnh camera Android hợp lệ vẫn có thể làm libjpeg khó chịu (Motion Photo nối
   * cả đoạn video sau EOI, JPEG progressive, ICC profile lạ). Chạy lượt nghiêm
   * trước để không nuốt lỗi thật, hỏng thì thử lại ở chế độ khoan dung — thà
   * lưu được ảnh minh chứng còn hơn bắt giáo viên đứng giữa sân trường chụp lại.
   *
   * Nhưng file **thiếu dữ liệu** thì không chữa kiểu đó: mạng di động đứt giữa
   * chừng là chuyện thường, và lượt khoan dung sẽ dựng ra một tấm ảnh xám nửa
   * dưới rồi lưu như minh chứng thật. Ca đó phải báo rõ để giáo viên gửi lại.
   */
  private async toWebp(file: Express.Multer.File): Promise<Buffer> {
    const truncated = this.looksTruncated(file.buffer);

    try {
      return await this.encode(file.buffer, 'error');
    } catch (error) {
      // Lỗi đã có mã riêng (sai định dạng thật) thì giữ nguyên, đừng dán nhãn
      // "ảnh hỏng" lên trên.
      if (error instanceof HttpException) throw error;

      // Log nguyên văn lỗi của sharp: message trả cho client cố tình chung
      // chung, còn muốn lần ra nguyên nhân thì phải có dòng này.
      this.logger.warn(
        `Giải mã ảnh báo giảng thất bại: ${this.describe(file, truncated)} — ${this.reasonOf(error)}`,
      );

      if (truncated) {
        throw imageError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'LESSON_IMAGE_TRUNCATED',
          'Ảnh tải lên bị thiếu dữ liệu, có thể do mạng gián đoạn giữa chừng. Vui lòng thử gửi lại.',
        );
      }

      try {
        const recovered = await this.encode(file.buffer, 'none');
        this.logger.log(
          `Cứu được ảnh báo giảng ở chế độ khoan dung: ${this.describe(file, truncated)}`,
        );
        return recovered;
      } catch (fallbackError) {
        this.logger.error(
          `Không đọc được ảnh báo giảng kể cả khi bỏ kiểm tra: ${this.describe(
            file,
            truncated,
          )} — ${this.reasonOf(fallbackError)}`,
        );
        throw imageError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'LESSON_IMAGE_UNREADABLE',
          'Ảnh bị hỏng hoặc không thể xử lý',
        );
      }
    }
  }

  private async encode(
    buffer: Buffer,
    failOn: 'error' | 'none',
  ): Promise<Buffer> {
    const image = sharp(buffer, { failOn, limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();

    if (!['jpeg', 'png', 'webp'].includes(metadata.format || '')) {
      throw imageError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'LESSON_IMAGE_TYPE_UNSUPPORTED',
        'Chỉ hỗ trợ ảnh JPEG, PNG, WebP hoặc video MP4, MOV, WebM',
      );
    }
    if (!metadata.width || !metadata.height) {
      throw new Error('ảnh không có kích thước');
    }

    return image.rotate().webp({ quality: 85 }).toBuffer();
  }

  /**
   * sharp dồn cả chồng lỗi của libvips vào `message`, mỗi dòng một cái. Gộp về
   * một dòng để `grep` ra được, và cắt bớt cho khỏi ngập log.
   */
  private reasonOf(error: unknown): string {
    return String((error as Error)?.message ?? error)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' | ')
      .slice(0, 300);
  }

  /** Mô tả file cho log — chỉ metadata, không bao giờ ghi nội dung ảnh. */
  private describe(file: Express.Multer.File, truncated: boolean): string {
    return [
      `name=${file.originalname ?? '?'}`,
      `mime=${file.mimetype}`,
      `size=${file.buffer?.byteLength ?? 0}`,
      `truncated=${truncated}`,
    ].join(' ');
  }

  /**
   * File có bị cắt cụt giữa chừng không — dấu hiệu kết thúc của từng định dạng.
   *
   * JPEG: tìm EOI ở **bất kỳ đâu** chứ không riêng cuối file. Motion Photo của
   * Samsung nối nguyên đoạn MP4 sau EOI, xét mỗi mấy byte cuối thì tấm ảnh
   * nguyên vẹn nào cũng bị kết luận là hỏng.
   */
  private looksTruncated(buffer: Buffer): boolean {
    if (buffer.length < 12) return true;

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return buffer.indexOf(Buffer.from([0xff, 0xd9]), 2) === -1;
    }
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return buffer.indexOf(Buffer.from('IEND', 'ascii'), 8) === -1;
    }
    if (buffer.toString('ascii', 0, 4) === 'RIFF') {
      // Cỡ file khai trong header RIFF không tính 8 byte đầu.
      return buffer.readUInt32LE(4) + 8 > buffer.length;
    }
    return false;
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
