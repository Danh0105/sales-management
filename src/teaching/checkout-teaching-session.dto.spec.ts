import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CheckinTeachingSessionDto,
  CheckoutTeachingSessionDto,
  QueryTeachingSessionsDto,
} from './dto/teaching-session.dto';
import { SessionStatus } from './teaching.enum';

describe('CheckinTeachingSessionDto multipart validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const metadata = {
    type: 'body' as const,
    metatype: CheckinTeachingSessionDto,
  };

  it('chuyển tọa độ multipart từ chuỗi sang số', async () => {
    const result = await pipe.transform(
      { latitude: '10.7', longitude: '106.7' },
      metadata,
    );

    expect(result).toEqual({ latitude: 10.7, longitude: 106.7 });
  });

  it.each([
    { latitude: '' },
    { latitude: 'north' },
    { latitude: '91' },
    { longitude: '' },
    { longitude: 'east' },
    { longitude: '181' },
  ])('từ chối tọa độ multipart không hợp lệ: %p', async (change) => {
    await expect(
      pipe.transform(
        { latitude: '10.7', longitude: '106.7', ...change },
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CheckoutTeachingSessionDto multipart validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const valid = {
    latitude: '10.758341',
    longitude: '106.745863',
  };

  it('chuyển tọa độ và accuracy multipart từ chuỗi sang số', async () => {
    const result = await pipe.transform(
      { ...valid, accuracy: '18' },
      {
        type: 'body',
        metatype: CheckoutTeachingSessionDto,
      },
    );

    expect(result).toEqual({
      latitude: 10.758341,
      longitude: 106.745863,
      accuracy: 18,
    });
  });

  it.each([undefined, '', null, 'null'])(
    'cho phép accuracy %p',
    async (accuracy) => {
      const result = await pipe.transform(
        { ...valid, accuracy },
        {
          type: 'body',
          metatype: CheckoutTeachingSessionDto,
        },
      );
      expect(result).toMatchObject({
        latitude: 10.758341,
        longitude: 106.745863,
      });
      expect(result.accuracy).toBeUndefined();
    },
  );

  it.each(['-1', '1.5'])('từ chối accuracy %s', async (accuracy) => {
    await expect(
      pipe.transform(
        { ...valid, accuracy },
        {
          type: 'body',
          metatype: CheckoutTeachingSessionDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    { latitude: '' },
    { longitude: '181' },
  ])('từ chối form không hợp lệ: %p', async (change) => {
    await expect(
      pipe.transform(
        { ...valid, ...change },
        {
          type: 'body',
          metatype: CheckoutTeachingSessionDto,
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('QueryTeachingSessionsDto excludeStatus', () => {
  // Cùng cấu hình pipe với TeachingSessionController.
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const metadata = {
    type: 'query' as const,
    metatype: QueryTeachingSessionsDto,
  };

  it('nhận excludeStatus=PRESENT từ query string', async () => {
    const result = await pipe.transform(
      { fromDate: '2026-10-01', toDate: '2026-10-31', excludeStatus: 'PRESENT' },
      metadata,
    );

    expect(result.excludeStatus).toBe(SessionStatus.PRESENT);
  });

  it('từ chối excludeStatus không thuộc trạng thái buổi dạy', async () => {
    await expect(
      pipe.transform({ excludeStatus: 'DONE' }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('QueryTeachingSessionsDto progress', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true });
  const metadata = {
    type: 'query' as const,
    metatype: QueryTeachingSessionsDto,
  };

  it.each(['COMPLETE', 'INCOMPLETE'])('nhận progress=%s', async (progress) => {
    const result = await pipe.transform({ progress }, metadata);
    expect(result.progress).toBe(progress);
  });

  it('từ chối progress không hợp lệ', async () => {
    await expect(
      pipe.transform({ progress: 'DONE' }, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
