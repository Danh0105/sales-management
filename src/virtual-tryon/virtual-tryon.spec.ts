import { NotFoundException } from '@nestjs/common';

import { VirtualTryOnService } from './virtual-tryon.service';
import { TryOnJobStatus } from './virtual-tryon.enum';
import { DEFAULT_TRYON_PROMPT } from './virtual-tryon.constants';

/** Chờ các promise nền (job chạy không await) chạy xong. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeService(overrides: {
  generate?: jest.Mock;
  storeUpload?: jest.Mock;
  job?: any;
} = {}) {
  const saved: any = {
    id: 1,
    status: TryOnJobStatus.PENDING,
    personImageUrl: '/uploads/virtual-tryon/person-a.webp',
    garmentImageUrl: '/uploads/virtual-tryon/garment-a.webp',
    prompt: DEFAULT_TRYON_PROMPT,
    model: 'gpt-image-2',
    size: '1024x1536',
    createdAt: new Date(),
    ...overrides.job,
  };

  const jobRepo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ ...saved, ...data })),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn().mockResolvedValue(saved),
    find: jest.fn().mockResolvedValue([]),
    findAndCount: jest.fn().mockResolvedValue([[saved], 1]),
  };

  const storage = {
    storeUpload:
      overrides.storeUpload ??
      jest
        .fn()
        .mockImplementation(async (_f: unknown, kind: string) =>
          `/uploads/virtual-tryon/${kind}-a.webp`,
        ),
    storeResult: jest
      .fn()
      .mockResolvedValue('/uploads/virtual-tryon/result-a.png'),
    read: jest.fn().mockResolvedValue(Buffer.from('img')),
    remove: jest.fn().mockResolvedValue(undefined),
    publicUrl: jest.fn((url: string | null) => url),
  };

  const openai = {
    defaultModel: 'gpt-image-2',
    defaultSize: '1024x1536',
    generate:
      overrides.generate ??
      jest.fn().mockResolvedValue({
        base64: 'aGVsbG8=',
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 1234,
      }),
  };

  const service = new VirtualTryOnService(
    jobRepo as any,
    openai as any,
    storage as any,
  );

  return { service, jobRepo, storage, openai };
}

const files = {
  person: { buffer: Buffer.from('p') } as any,
  garment: { buffer: Buffer.from('g') } as any,
};

describe('VirtualTryOnService', () => {
  it('tạo job trả về ngay ở trạng thái PENDING (không chờ sinh ảnh)', async () => {
    const { service, openai } = makeService();

    const job = await service.create(files, {}, 7);

    expect(job.status).toBe(TryOnJobStatus.PENDING);
    expect(job.prompt).toBe(DEFAULT_TRYON_PROMPT);
    // Chưa gọi mô hình tại thời điểm response trả về.
    expect(openai.generate).not.toHaveBeenCalled();
  });

  it('chạy nền xong thì lưu ảnh kết quả và chuyển SUCCEEDED', async () => {
    const { service, jobRepo, storage } = makeService();

    await service.create(files, {}, 7);
    await flush();

    expect(storage.storeResult).toHaveBeenCalledWith('aGVsbG8=');
    expect(jobRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: TryOnJobStatus.SUCCEEDED,
        resultImageUrl: '/uploads/virtual-tryon/result-a.png',
        inputTokens: 500,
        outputTokens: 200,
      }),
    );
  });

  it('mô hình lỗi thì job FAILED kèm mã lỗi, không văng ra ngoài', async () => {
    const { service, jobRepo } = makeService({
      generate: jest.fn().mockRejectedValue(
        Object.assign(new Error('Bad request'), { status: 400 }),
      ),
    });

    await expect(service.create(files, {}, 7)).resolves.toBeDefined();
    await flush();

    expect(jobRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: TryOnJobStatus.FAILED,
        errorCode: 'TRYON_INPUT_REJECTED',
      }),
    );
  });

  it('hết hạn mức OpenAI trả mã riêng để client biết thử lại sau', async () => {
    const { service, jobRepo } = makeService({
      generate: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('rate'), { status: 429 })),
    });

    await service.create(files, {}, 7);
    await flush();

    expect(jobRepo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ errorCode: 'TRYON_RATE_LIMITED' }),
    );
  });

  it('ảnh thứ hai hỏng thì dọn luôn ảnh thứ nhất đã ghi', async () => {
    const storeUpload = jest
      .fn()
      .mockResolvedValueOnce('/uploads/virtual-tryon/person-a.webp')
      .mockRejectedValueOnce(new Error('ảnh hỏng'));
    const { service, storage } = makeService({ storeUpload });

    await expect(service.create(files, {}, 7)).rejects.toThrow('ảnh hỏng');
    expect(storage.remove).toHaveBeenCalledWith(
      '/uploads/virtual-tryon/person-a.webp',
    );
  });

  it('người khác không xem được job không phải của mình', async () => {
    const { service } = makeService({ job: { createdBy: 7 } });

    await expect(
      service.findOne(1, { viewerId: 99, canViewAll: false }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.findOne(1, { viewerId: 7, canViewAll: false }),
    ).resolves.toMatchObject({ id: 1 });
    // Vai trò quản lý vẫn xem được.
    await expect(
      service.findOne(1, { viewerId: 99, canViewAll: true }),
    ).resolves.toMatchObject({ id: 1 });
  });

  it('xoá job thì dọn cả 3 ảnh trên đĩa', async () => {
    const { service, storage } = makeService({
      job: { createdBy: 7, resultImageUrl: '/uploads/virtual-tryon/result-a.png' },
    });

    await service.remove(1, { viewerId: 7, canViewAll: false });

    expect(storage.remove).toHaveBeenCalledWith('/uploads/virtual-tryon/person-a.webp');
    expect(storage.remove).toHaveBeenCalledWith('/uploads/virtual-tryon/garment-a.webp');
    expect(storage.remove).toHaveBeenCalledWith('/uploads/virtual-tryon/result-a.png');
  });

  it('khởi động lại thì job dở dang bị đánh dấu FAILED để client ngừng chờ', async () => {
    const { service, jobRepo } = makeService();
    jobRepo.find.mockResolvedValue([{ id: 3 }, { id: 4 }]);

    await service.onModuleInit();

    expect(jobRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: TryOnJobStatus.FAILED,
        errorCode: 'TRYON_INTERRUPTED',
      }),
    );
  });
});
