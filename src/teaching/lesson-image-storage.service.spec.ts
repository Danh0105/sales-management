import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { LessonImageStorageService } from './lesson-image-storage.service';

describe('LessonImageStorageService', () => {
  let directory: string;
  let service: LessonImageStorageService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lesson-images-'));
    service = new LessonImageStorageService({
      get: (key: string) =>
        key === 'LESSON_IMAGE_UPLOAD_DIR' ? directory : '',
    } as ConfigService);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  const image = async (format: 'jpeg' | 'png' | 'webp' = 'png') =>
    ({
      buffer: await sharp({
        create: { width: 20, height: 10, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer(),
      mimetype: `image/${format}`,
    }) as Express.Multer.File;

  it.each(['jpeg', 'png', 'webp'] as const)(
    'lưu ảnh %s thành WebP',
    async (format) => {
      const [stored] = await service.storeMany([await image(format)]);
      expect(stored.url).toMatch(/^\/uploads\/lesson-images\/[\w-]+\.webp$/);
      expect(
        (await sharp(await readFile(join(directory, stored.name))).metadata())
          .format,
      ).toBe('webp');
    },
  );

  it('lưu nhiều ảnh và xóa được toàn bộ', async () => {
    const stored = await service.storeMany([
      await image(),
      await image('jpeg'),
    ]);
    expect(stored).toHaveLength(2);
    await service.removeMany(stored);
    expect(await readdir(directory)).toEqual([]);
  });

  it('lưu và công khai video MP4 làm minh chứng', async () => {
    const buffer = Buffer.concat([
      Buffer.from([0, 0, 0, 20]),
      Buffer.from('ftypisom'),
      Buffer.from('video-test'),
    ]);
    const [stored] = await service.storeMany([
      { buffer, mimetype: 'video/mp4' } as Express.Multer.File,
    ]);

    expect(stored.name).toMatch(/\.mp4$/);
    expect(await readFile(join(directory, stored.name))).toEqual(buffer);
    expect(service.publicItems([stored])).toEqual([
      {
        id: 1,
        url: stored.url,
        mimeType: 'video/mp4',
        mediaType: 'video',
      },
    ]);
  });

  it('gắn id, mimeType, size và thứ tự cho từng ảnh', async () => {
    const stored = await service.storeMany([
      await image(),
      await image('jpeg'),
      await image('webp'),
    ]);

    expect(stored.map((item) => item.sortOrder)).toEqual([0, 1, 2]);
    expect(new Set(stored.map((item) => item.id)).size).toBe(3);
    stored.forEach((item) => {
      expect(item.name).toBe(`${item.id}.webp`);
      expect(item.url).toBe(`/uploads/lesson-images/${item.name}`);
      expect(item.mimeType).toBe('image/webp');
      expect(item.size).toBeGreaterThan(0);
    });
  });

  it('trả contract tối giản cho ảnh cũ', async () => {
    expect(
      service.publicItems([
        { url: '/uploads/lesson-images/a.webp', name: 'a.webp' },
        { url: '/uploads/lesson-images/b.webp' },
      ]),
    ).toEqual([
      {
        id: 1,
        url: '/uploads/lesson-images/a.webp',
      },
      {
        id: 2,
        url: '/uploads/lesson-images/b.webp',
      },
    ]);
  });

  it('chỉ công khai id và URL, trả mảng rỗng khi chưa có ảnh', async () => {
    const [stored] = await service.storeMany([await image()]);
    expect(service.publicItems([stored])).toEqual([{ id: 1, url: stored.url }]);
    expect(service.publicItems(null)).toEqual([]);
    expect(service.publicItems(undefined)).toEqual([]);
  });

  it('tạo URL tuyệt đối khi có PUBLIC_BASE_URL', async () => {
    service = new LessonImageStorageService({
      get: (key: string) =>
        key === 'LESSON_IMAGE_UPLOAD_DIR'
          ? directory
          : key === 'PUBLIC_BASE_URL'
            ? 'https://api.example.com/'
            : '',
    } as ConfigService);
    expect(
      service.publicItems([
        { url: '/uploads/lesson-images/a.webp', name: 'a.webp' },
      ])[0].url,
    ).toBe('https://api.example.com/uploads/lesson-images/a.webp');
  });

  it.each([
    ['GIF', Buffer.from('GIF89a')],
    ['PDF giả MIME', Buffer.from('%PDF-1.7')],
  ])('từ chối %s với 415', async (_name, buffer) => {
    await expect(
      service.storeMany([
        { buffer, mimetype: 'image/png' } as Express.Multer.File,
      ]),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('từ chối ảnh có magic bytes đúng nhưng nội dung hỏng với 422', async () => {
    await expect(
      service.storeMany([
        { buffer: Buffer.from([0xff, 0xd8, 0xff, 0]) } as Express.Multer.File,
      ]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('dọn ảnh đã lưu nếu ảnh sau bị lỗi', async () => {
    await expect(
      service.storeMany([
        await image(),
        { buffer: Buffer.from('%PDF') } as Express.Multer.File,
      ]),
    ).rejects.toBeInstanceOf(HttpException);
    expect(await readdir(directory)).toEqual([]);
  });
});
