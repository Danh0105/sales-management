import { ForbiddenException, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Employee } from '../employee/employee.entity';
import { PolicyContractAccessService } from '../policy/policy-contract-access.service';
import { PolicyContractArchiveService } from '../policy/policy-contract-archive.service';
import { PolicyContractMediaController } from '../policy/policy-contract-media.controller';
import { AppVersionService } from '../version/version.service';
import { AdminVersionController } from '../version/admin-version.controller';
import { VirtualTryOnController } from '../virtual-tryon/virtual-tryon.controller';
import { VirtualTryOnRateLimitService } from '../virtual-tryon/virtual-tryon-rate-limit.service';
import { VirtualTryOnService } from '../virtual-tryon/virtual-tryon.service';
import { FaceController } from './face.controller';
import { FaceService } from './face.service';
import { JwtStrategy } from './jwt.strategy';
import { RolesGuard } from './role-guard';

describe('Các route bảo mật 401/403', () => {
  let app: INestApplication;
  let jwt: JwtService;

  const employees = new Map([
    [1, { id: 1, name: 'Director', roles: ['director'], isActive: true }],
    [2, { id: 2, name: 'Sales', roles: ['sales'], isActive: true }],
  ]);
  const face = { registerByFace: jest.fn().mockResolvedValue({ ok: true }) };
  const tryOn = { remove: jest.fn().mockResolvedValue({ deleted: true }) };
  const contractAccess = {
    assertCanRead: jest.fn(async (user) => {
      if (user.id !== 1) throw new ForbiddenException('Ngoài phạm vi');
    }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({ secret: 'test-jwt-secret' }),
      ],
      controllers: [
        FaceController,
        AdminVersionController,
        PolicyContractMediaController,
        VirtualTryOnController,
      ],
      providers: [
        JwtStrategy,
        RolesGuard,
        { provide: FaceService, useValue: face },
        { provide: AppVersionService, useValue: { create: jest.fn() } },
        { provide: VirtualTryOnService, useValue: tryOn },
        { provide: VirtualTryOnRateLimitService, useValue: {} },
        { provide: PolicyContractAccessService, useValue: contractAccess },
        {
          provide: PolicyContractArchiveService,
          useValue: { locate: jest.fn().mockResolvedValue(null), archiveAvailable: () => true },
        },
        {
          provide: getRepositoryToken(Employee),
          useValue: { findOne: jest.fn(({ where }) => employees.get(where.id) ?? null) },
        },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-jwt-secret' },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    jwt = module.get(JwtService);
    await app.init();
  });

  afterAll(() => app.close());

  const token = (id: number, roles: string[]) => jwt.sign({ sub: id, roles });

  it.each([
    ['post', '/face/register'],
    ['post', '/admin/version/upload'],
    ['get', '/uploads/policy-contracts/test.pdf'],
    ['delete', '/virtual-tryon/1'],
  ] as const)('%s %s trả 401 khi chưa đăng nhập', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
  });

  it('POST /face/register trả 403 cho nhân viên không có quyền', () =>
    request(app.getHttpServer())
      .post('/face/register')
      .set('Authorization', `Bearer ${token(2, ['sales'])}`)
      .send({ descriptors: [[0.1]], name: 'x' })
      .expect(403));

  it('POST /admin/version/upload trả 403 cho nhân viên không có quyền', () =>
    request(app.getHttpServer())
      .post('/admin/version/upload')
      .set('Authorization', `Bearer ${token(2, ['sales'])}`)
      .expect(403));

  it('policy contract trả 403 khi tài liệu ngoài phạm vi', () =>
    request(app.getHttpServer())
      .get('/uploads/policy-contracts/test.pdf')
      .set('Authorization', `Bearer ${token(2, ['sales'])}`)
      .expect(403));

  it('DELETE virtual-tryon truyền đúng danh tính đã xác thực xuống service', async () => {
    await request(app.getHttpServer())
      .delete('/virtual-tryon/1')
      .set('Authorization', `Bearer ${token(2, ['sales'])}`)
      .expect(200);
    expect(tryOn.remove).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ viewerId: 2, token: null }),
    );
  });
});
