import {
  UnsupportedMediaTypeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { AvatarStorageService } from './avatar-storage.service';

describe('AvatarStorageService', () => {
  let directory: string;
  let service: AvatarStorageService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'teacher-avatar-'));
    service = new AvatarStorageService({
      get: (key: string) => (key === 'AVATAR_UPLOAD_DIR' ? directory : ''),
    } as ConfigService);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  it.each(['jpeg', 'png', 'webp'] as const)(
    'accepts and normalizes %s to a square WebP',
    async (format) => {
      const input = await sharp({
        create: { width: 800, height: 600, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      const url = await service.store({ buffer: input } as Express.Multer.File);
      const output = await readFile(join(directory, url.split('/').pop()!));
      const metadata = await sharp(output).metadata();
      expect(metadata.format).toBe('webp');
      expect(metadata.width).toBe(512);
      expect(metadata.height).toBe(512);
    },
  );

  it('rejects GIF/PDF and a forged MIME type using magic bytes', async () => {
    await expect(
      service.store({
        buffer: Buffer.from('%PDF'),
        mimetype: 'image/png',
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it('returns 422 for corrupt data with a supported signature', async () => {
    await expect(
      service.store({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0, 1]),
      } as Express.Multer.File),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('deletes only generated avatar paths', async () => {
    const input = await sharp({
      create: { width: 10, height: 10, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    const url = await service.store({ buffer: input } as Express.Multer.File);
    await service.remove(url);
    await expect(
      readFile(join(directory, url.split('/').pop()!)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
