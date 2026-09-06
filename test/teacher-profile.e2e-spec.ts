import { CanActivate, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/role-guard';
import { TeacherController } from '../src/teaching/teacher.controller';
import { TeacherService } from '../src/teaching/teacher.service';

describe('Teacher profile API (e2e contract)', () => {
  let app: INestApplication;
  const profile = {
    id: 7,
    name: 'Nguyễn Văn A',
    phone: '0901234567',
    email: 'teacher@example.com',
    avatarUrl: null,
    updatedAt: new Date().toISOString(),
  };
  const service = {
    findByEmployeeId: jest.fn().mockResolvedValue(profile),
    updateMine: jest.fn().mockResolvedValue(profile),
  };
  const authGuard: CanActivate = {
    canActivate: (context) => {
      context.switchToHttp().getRequest().user = {
        id: 42,
        roles: ['giaovien'],
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TeacherController],
      providers: [{ provide: TeacherService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('gets the current profile with a nullable avatar', async () => {
    await request(app.getHttpServer())
      .get('/teachers/me')
      .expect(200)
      .expect(profile);
    expect(service.findByEmployeeId).toHaveBeenCalledWith(42);
  });

  it('normalizes fields and permits partial/multiple updates', async () => {
    await request(app.getHttpServer())
      .patch('/teachers/me')
      .field('name', '  Nguyễn Văn B  ')
      .field('phone', '+84 901 234 567')
      .field('email', ' TEACHER@EXAMPLE.COM ')
      .expect(200);
    expect(service.updateMine).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        name: 'Nguyễn Văn B',
        phone: '+84901234567',
        email: 'teacher@example.com',
      }),
      undefined,
    );
  });

  it('passes a valid uploaded file and rejects administrator fields', async () => {
    await request(app.getHttpServer())
      .patch('/teachers/me')
      .attach('avatar', Buffer.from([0xff, 0xd8, 0xff, 1]), 'avatar.jpg')
      .expect(200);
    expect(service.updateMine.mock.calls[0][2]).toEqual(
      expect.objectContaining({ buffer: expect.any(Buffer) }),
    );
    await request(app.getHttpServer())
      .patch('/teachers/me')
      .field('role', 'director')
      .expect(400);
  });

  it('returns 413 above 10 MB', async () => {
    await request(app.getHttpServer())
      .patch('/teachers/me')
      .attach('avatar', Buffer.alloc(10 * 1024 * 1024 + 1), 'large.png')
      .expect(413);
  });
});
