import { CanActivate, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { TeachingBulkService } from './teaching-bulk.service';
import { TeachingSessionController } from './teaching-session.controller';
import { TeachingSessionService } from './teaching-session.service';
import { TEACHER_STAFF_ROLE } from './teaching-roles';

describe('POST /teaching-sessions/:id/checkout multipart', () => {
  let app: INestApplication;
  const service = { checkout: jest.fn().mockResolvedValue({ id: 7 }) };
  const allow: CanActivate = {
    canActivate: (context) => {
      context.switchToHttp().getRequest().user = {
        id: 99,
        roles: [TEACHER_STAFF_ROLE],
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TeachingSessionController],
      providers: [
        { provide: TeachingSessionService, useValue: service },
        { provide: TeachingBulkService, useValue: {} },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  const form = () =>
    request(app.getHttpServer())
      .post('/teaching-sessions/7/checkout')
      .field('latitude', '10.758341')
      .field('longitude', '106.745863');

  it('check-out không ảnh và không accuracy', async () => {
    await form().expect(200, { id: 7 });
    expect(service.checkout).toHaveBeenCalledWith(
      7,
      {
        latitude: 10.758341,
        longitude: 106.745863,
        accuracy: undefined,
      },
      99,
      [],
      undefined,
    );
  });

  it('chuyển tiếp x-request-id cho service', async () => {
    await form().set('x-request-id', 'req-abc').expect(200);
    expect(service.checkout.mock.calls[0][4]).toBe('req-abc');
  });

  it('không nhận file minh chứng tại endpoint checkout', async () => {
    await form().attach('images', Buffer.from('x'), 'a.png').expect(400);
    expect(service.checkout).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5'])('từ chối accuracy %s', async (accuracy) => {
    await form().field('accuracy', accuracy).expect(400);
  });
});
