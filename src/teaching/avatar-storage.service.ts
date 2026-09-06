import {
  Injectable,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { join, resolve, sep } from 'path';
import sharp from 'sharp';

@Injectable()
export class AvatarStorageService {
  private readonly directory: string;

  constructor(private readonly config: ConfigService) {
    this.directory = resolve(
      config.get('AVATAR_UPLOAD_DIR') ||
        join(process.cwd(), 'uploads', 'avatars'),
    );
  }

  async store(file: Express.Multer.File): Promise<string> {
    const format = this.detectFormat(file.buffer);
    if (!format)
      throw new UnsupportedMediaTypeException(
        'Định dạng ảnh đại diện không được hỗ trợ',
      );

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
      const side = Math.min(metadata.width, metadata.height);
      output = await image
        .extract({
          left: Math.floor((metadata.width - side) / 2),
          top: Math.floor((metadata.height - side) / 2),
          width: side,
          height: side,
        })
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
        .rotate()
        .webp({ quality: 82 })
        .toBuffer();
    } catch {
      throw new UnprocessableEntityException('Không thể xử lý ảnh đại diện');
    }

    await mkdir(this.directory, { recursive: true });
    const filename = `${randomUUID()}.webp`;
    await writeFile(join(this.directory, filename), output, { flag: 'wx' });
    return `/uploads/avatars/${filename}`;
  }

  async remove(url?: string | null): Promise<void> {
    if (!url?.startsWith('/uploads/avatars/')) return;
    const filename = url.slice('/uploads/avatars/'.length);
    if (!/^[0-9a-f-]{36}\.webp$/i.test(filename)) return;
    const target = resolve(this.directory, filename);
    if (!target.startsWith(`${this.directory}${sep}`)) return;
    await unlink(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  publicUrl(url?: string | null): string | null {
    if (!url) return null;
    const base = (this.config.get<string>('PUBLIC_BASE_URL') || '').replace(
      /\/$/,
      '',
    );
    return base ? `${base}${url}` : url;
  }

  private detectFormat(buffer: Buffer): 'jpeg' | 'png' | 'webp' | null {
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    )
      return 'jpeg';
    if (
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return 'png';
    if (
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    )
      return 'webp';
    return null;
  }
}
