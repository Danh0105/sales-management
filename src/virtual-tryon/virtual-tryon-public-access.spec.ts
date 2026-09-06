import { HttpException, NotFoundException } from '@nestjs/common';

import { VirtualTryOnService } from './virtual-tryon.service';
import { VirtualTryOnRateLimitService } from './virtual-tryon-rate-limit.service';
import { TryOnJobStatus } from './virtual-tryon.enum';

function makeService(job: Record<string, unknown> = {}) {
  const saved: any = {
    id: 1,
    status: TryOnJobStatus.SUCCEEDED,
    personImageUrl: '/uploads/virtual-tryon/person-a.webp',
    garmentImageUrl: '/uploads/virtual-tryon/garment-a.webp',
    prompt: 'p',
    model: 'gpt-image-2',
    size: '1024x1536',
    createdBy: null,
    publicToken: 'secret-token',
    createdAt: new Date(),
    ...job,
  };

  const service = new VirtualTryOnService(
    {
      create: jest.fn((d) => d),
      save: jest.fn(async (d) => ({ ...saved, ...d })),
      findOne: jest.fn().mockResolvedValue(saved),
      update: jest.fn(),
      delete: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    } as any,
    { defaultModel: 'gpt-image-2', defaultSize: '1024x1536', generate: jest.fn() } as any,
    {
      storeUpload: jest.fn().mockResolvedValue('/uploads/virtual-tryon/x.webp'),
      remove: jest.fn(),
      publicUrl: jest.fn((u: string) => u),
    } as any,
  );

  return service;
}

describe('Thử đồ ảo — truy cập công khai bằng token', () => {
  it('khách ẩn danh tạo job thì được cấp publicToken', async () => {
    const service = makeService();

    const created: any = await service.create(
      { person: { buffer: Buffer.from('p') } as any, garment: { buffer: Buffer.from('g') } as any },
      {},
      undefined,
    );

    expect(created.publicToken).toEqual(expect.any(String));
    expect(created.publicToken.length).toBeGreaterThan(20);
  });

  it('người đã đăng nhập KHÔNG cần token (job gắn tài khoản)', async () => {
    const service = makeService();

    const created: any = await service.create(
      { person: { buffer: Buffer.from('p') } as any, garment: { buffer: Buffer.from('g') } as any },
      {},
      7,
    );

    expect(created.publicToken).toBeNull();
  });

  it('đúng token thì xem được job ẩn danh', async () => {
    const service = makeService();

    await expect(
      service.findOne(1, { token: 'secret-token' }),
    ).resolves.toMatchObject({ id: 1 });
  });

  it('sai token hoặc không token thì coi như không tồn tại', async () => {
    const service = makeService();

    await expect(service.findOne(1, { token: 'sai-token' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.findOne(1, {})).rejects.toThrow(NotFoundException);
  });

  it('token không rò ra ở API xem job', async () => {
    const service = makeService();

    const item: any = await service.findOne(1, { token: 'secret-token' });

    expect(item.publicToken).toBeUndefined();
  });
});

describe('Thử đồ ảo — giới hạn theo IP', () => {
  const makeLimiter = (max = 2) =>
    new VirtualTryOnRateLimitService({
      get: (key: string) =>
        key === 'VIRTUAL_TRYON_RATE_MAX' ? String(max) : undefined,
    } as any);

  const req = (ip: string) =>
    ({ headers: { 'x-forwarded-for': ip }, socket: {} }) as any;

  it('khách vãng lai vượt hạn mức thì bị chặn 429', () => {
    const limiter = makeLimiter(2);

    limiter.consume(req('1.1.1.1'), false);
    limiter.consume(req('1.1.1.1'), false);

    try {
      limiter.consume(req('1.1.1.1'), false);
      throw new Error('đáng lẽ phải bị chặn');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as any).getResponse().code).toBe('TRYON_RATE_LIMITED_IP');
    }
  });

  it('IP khác nhau đếm riêng', () => {
    const limiter = makeLimiter(1);

    limiter.consume(req('1.1.1.1'), false);
    expect(() => limiter.consume(req('2.2.2.2'), false)).not.toThrow();
  });

  it('người đã đăng nhập được miễn giới hạn', () => {
    const limiter = makeLimiter(1);

    limiter.consume(req('1.1.1.1'), true);
    limiter.consume(req('1.1.1.1'), true);
    expect(() => limiter.consume(req('1.1.1.1'), true)).not.toThrow();
  });

  it('lỗi hệ thống thì hoàn lại lượt đã trừ', () => {
    const limiter = makeLimiter(1);

    limiter.consume(req('1.1.1.1'), false);
    limiter.refund(req('1.1.1.1'), false);

    expect(() => limiter.consume(req('1.1.1.1'), false)).not.toThrow();
  });

  it('lấy đúng IP gốc khi qua nhiều proxy', () => {
    const limiter = makeLimiter();

    expect(
      limiter.clientIp({
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        socket: {},
      } as any),
    ).toBe('203.0.113.9');
  });
});
