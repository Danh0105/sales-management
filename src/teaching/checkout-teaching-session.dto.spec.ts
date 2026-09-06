import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CheckinTeachingSessionDto,
  CheckoutTeachingSessionDto,
} from './dto/teaching-session.dto';

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
