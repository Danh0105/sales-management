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

describe('LessonImageStorageService — ảnh camera Android "khó"', () => {
  let directory: string;
  let service: LessonImageStorageService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lesson-images-'));
    service = new LessonImageStorageService({
      get: (key: string) => (key === 'LESSON_IMAGE_UPLOAD_DIR' ? directory : ''),
    } as ConfigService);
  });
  afterEach(() => rm(directory, { recursive: true, force: true }));

  /** Ảnh đủ lớn để cắt cụt vẫn còn phần đầu hợp lệ. */
  const photo = (options: sharp.JpegOptions = {}) =>
    sharp({
      create: { width: 600, height: 400, channels: 3, background: '#4488cc' },
    })
      .jpeg({ quality: 90, ...options })
      .toBuffer();

  const upload = (buffer: Buffer, originalname = '20260907_164148.jpg') =>
    ({ buffer, mimetype: 'image/jpeg', originalname }) as Express.Multer.File;

  const codeOf = async (file: Express.Multer.File) => {
    try {
      await service.storeMany([file]);
      return 'OK';
    } catch (error) {
      return (error as HttpException).getResponse()['code'];
    }
  };

  it('JPEG progressive vẫn lưu được', async () => {
    const [stored] = await service.storeMany([
      upload(await photo({ progressive: true })),
    ]);
    expect(stored.mimeType).toBe('image/webp');
  });

  it('Motion Photo (video nối sau EOI) vẫn lưu được, không bị coi là hỏng', async () => {
    const buffer = Buffer.concat([await photo(), Buffer.alloc(50_000, 7)]);
    const [stored] = await service.storeMany([upload(buffer)]);
    expect(stored.mimeType).toBe('image/webp');
  });

  it('ảnh bị cắt cụt báo mã riêng, không lẫn với ảnh hỏng', async () => {
    const full = await photo();
    const cut = upload(full.subarray(0, Math.floor(full.length * 0.6)));

    expect(await codeOf(cut)).toBe('LESSON_IMAGE_TRUNCATED');
    // Không được lặng lẽ lưu một tấm ảnh mất nửa dưới làm minh chứng.
    expect(await readdir(directory)).toEqual([]);
  });

  it('không nhận nhầm ảnh nguyên vẹn là bị cắt cụt', async () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      const buffer = await sharp({
        create: { width: 60, height: 40, channels: 3, background: 'red' },
      })
        .toFormat(format)
        .toBuffer();
      expect(
        await codeOf({ buffer, mimetype: `image/${format}` } as Express.Multer.File),
      ).toBe('OK');
    }
  });

  it('rác không giải mã nổi thì trả LESSON_IMAGE_UNREADABLE', async () => {
    // Có SOI và EOI nên qua được kiểm tra định dạng lẫn kiểm tra cắt cụt,
    // nhưng bên trong không có ảnh nào.
    const junk = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(64, 0x41),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(await codeOf(upload(junk))).toBe('LESSON_IMAGE_UNREADABLE');
  });

  it('ghi log kèm tên file và lỗi gốc của sharp khi giải mã hỏng', async () => {
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);

    const full = await photo();
    await codeOf(upload(full.subarray(0, 500), '20260907_164148.jpg'));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('20260907_164148.jpg'),
    );
    expect(warn.mock.calls[0][0]).toContain('truncated=true');
    // Nguyên văn lỗi của sharp, thứ trước đây bị nuốt mất.
    expect(warn.mock.calls[0][0]).toMatch(/premature end|VipsJpeg|Error/i);
  });
});
