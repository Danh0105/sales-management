import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtStrategy } from '../auth/jwt.strategy';
import { ZaloLocationController } from './zalo-location.controller';
import { ZaloLocationRateLimitGuard } from './zalo-location-rate-limit.guard';
import { ZaloLocationService } from './zalo-location.service';
import { TEACHER_STAFF_ROLE } from '../teaching/teaching-roles';

describe('ZaloLocationController integration', () => {
  let app: INestApplication;
  let jwt: JwtService;
  const service = {
    resolve: jest
      .fn()
      .mockResolvedValue({
        latitude: 10,
        longitude: 106,
        provider: 'gps',
        timestamp: null,
      }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({ secret: 'test-jwt-secret' }),
      ],
      controllers: [ZaloLocationController],
      providers: [
        JwtStrategy,
        ZaloLocationRateLimitGuard,
        { provide: ZaloLocationService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET' ? 'test-jwt-secret' : 'test',
          },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    jwt = module.get(JwtService);
    await app.init();
  });

  afterAll(() => app.close());

  const token = (roles: string[], expiresIn: number | string = 60) =>
    jwt.sign({ sub: 123, roles }, { expiresIn: expiresIn as never });

  it.each([
    [{ zaloAccessToken: 'access' }],
    [{ locationToken: 'location' }],
    [{ locationToken: ' ', zaloAccessToken: 'access' }],
  ])('trả 400 khi body thiếu hoặc token rỗng', async (body) => {
    await request(app.getHttpServer())
      .post('/zalo/location/resolve')
      .set('Authorization', `Bearer ${token([TEACHER_STAFF_ROLE])}`)
      .send(body)
      .expect(400);
  });

  it('trả 401 khi thiếu JWT', () =>
    request(app.getHttpServer())
      .post('/zalo/location/resolve')
      .send({ locationToken: 'l', zaloAccessToken: 'a' })
      .expect(401));

  it('trả 401 khi JWT hết hạn', () =>
    request(app.getHttpServer())
      .post('/zalo/location/resolve')
      .set('Authorization', `Bearer ${token([TEACHER_STAFF_ROLE], -1)}`)
      .send({ locationToken: 'l', zaloAccessToken: 'a' })
      .expect(401));

  it('trả 403 cho role khác giaovien', () =>
    request(app.getHttpServer())
      .post('/zalo/location/resolve')
      .set('Authorization', `Bearer ${token(['nhansu'])}`)
      .send({ locationToken: 'l', zaloAccessToken: 'a' })
      .expect(403));

  it('resolve thành công cho giáo viên', async () => {
    await request(app.getHttpServer())
      .post('/zalo/location/resolve')
      .set('Authorization', `Bearer ${token([TEACHER_STAFF_ROLE])}`)
      .send({ locationToken: ' location ', zaloAccessToken: ' access ' })
      .expect(200)
      .expect({
        latitude: 10,
        longitude: 106,
        provider: 'gps',
        timestamp: null,
      });
    expect(service.resolve).toHaveBeenCalledWith('location', 'access');
  });
});
