import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';

import { ActivityLogService } from '../src/activity-log/activity-log.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { Department } from '../src/department/department.entity';
import { Employee } from '../src/employee/employee.entity';
import { RecruitmentAiIdempotencyKey } from '../src/recruitment/entities/recruitment-ai-idempotency-key.entity';
import { RecruitmentApplication } from '../src/recruitment/entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../src/recruitment/entities/recruitment-candidate.entity';
import { RecruitmentConversation } from '../src/recruitment/entities/recruitment-conversation.entity';
import { RecruitmentHandoff } from '../src/recruitment/entities/recruitment-handoff.entity';
import { RecruitmentInterviewSlot } from '../src/recruitment/entities/recruitment-interview-slot.entity';
import { RecruitmentInterview } from '../src/recruitment/entities/recruitment-interview.entity';
import { RecruitmentJob } from '../src/recruitment/entities/recruitment-job.entity';
import { RecruitmentMessage } from '../src/recruitment/entities/recruitment-message.entity';
import { RecruitmentModule } from '../src/recruitment/recruitment.module';
import { RecruitmentInterviewService } from '../src/recruitment/services/recruitment-interview.service';

const KEY = 'test-recruitment-ai-key-0123456789abcdef';
const auth = { Authorization: `Bearer ${KEY}` };

const ENTITIES = [
  RecruitmentJob,
  RecruitmentCandidate,
  RecruitmentApplication,
  RecruitmentConversation,
  RecruitmentMessage,
  RecruitmentInterviewSlot,
  RecruitmentInterview,
  RecruitmentHandoff,
  RecruitmentAiIdempotencyKey,
  Department,
  Employee,
];

function queryBuilder() {
  const qb: any = {};
  for (const m of [
    'leftJoin',
    'leftJoinAndSelect',
    'addSelect',
    'select',
    'where',
    'andWhere',
    'orWhere',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
  qb.getMany = jest.fn().mockResolvedValue([]);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
}

function mockRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    exists: jest.fn().mockResolvedValue(false),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 1, ...v })),
    update: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => queryBuilder()),
  };
}

/** Bảng idempotency trong bộ nhớ, có unique (key, endpoint). */
function idempotencyRepo() {
  const rows: any[] = [];
  let seq = 0;
  return {
    rows,
    findOne: jest.fn(
      async ({ where }) =>
        rows.find(
          (r) =>
            r.idempotencyKey === where.idempotencyKey &&
            r.endpoint === where.endpoint,
        ) ?? null,
    ),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => {
      const row = { id: ++seq, createdAt: new Date(), ...v };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async ({ id }, patch) =>
      Object.assign(
        rows.find((r) => r.id === id),
        patch,
      ),
    ),
    delete: jest.fn(async ({ id }) =>
      rows.splice(
        rows.findIndex((r) => r.id === id),
        1,
      ),
    ),
  };
}

/** JWT giả: `x-test-roles: nhansu,director` → req.user. */
const fakeJwt: CanActivate = {
  canActivate: (context: ExecutionContext) => {
    const req = context.switchToHttp().getRequest();
    const roles = String(req.headers['x-test-roles'] ?? '');
    req.user = {
      id: 2,
      name: 'Người test',
      roles: roles ? roles.split(',') : [],
    };
    return true;
  },
};

describe('Recruitment API (e2e contract)', () => {
  let app: INestApplication;
  const repos = new Map<unknown, any>();
  let idem: ReturnType<typeof idempotencyRepo>;
  let interviews: RecruitmentInterviewService;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // Dựng đúng danh sách controller/provider của RecruitmentModule — chỉ thay
    // phần chạm DB — để kiểm DI wiring thật của module.
    const controllers = Reflect.getMetadata('controllers', RecruitmentModule);
    const providers = Reflect.getMetadata('providers', RecruitmentModule);

    idem = idempotencyRepo();
    for (const entity of ENTITIES) {
      repos.set(
        entity,
        entity === RecruitmentAiIdempotencyKey ? idem : mockRepo(),
      );
    }
    const em = { getRepository: (e: unknown) => repos.get(e) };

    const moduleRef = await Test.createTestingModule({
      controllers,
      providers: [
        ...providers,
        ...ENTITIES.map((e) => ({
          provide: getRepositoryToken(e),
          useValue: repos.get(e),
        })),
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn(async (cb: any) => cb(em)),
            manager: em,
            getRepository: em.getRepository,
          },
        },
        { provide: ActivityLogService, useValue: { record: jest.fn() } },
        {
          provide: ConfigService,
          useValue: {
            get: (name: string) =>
              ({
                RECRUITMENT_AI_ENABLED: 'true',
                RECRUITMENT_AI_API_KEY: KEY,
              })[name],
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    interviews = moduleRef.get(RecruitmentInterviewService);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('xác thực API AI', () => {
    it('thiếu API key → 401', async () => {
      const res = await request(app.getHttpServer()).get(
        '/recruitment/ai/jobs/active',
      );
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'INVALID_API_KEY' });
    });

    it('sai API key → 401', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/ai/jobs/active')
        .set('Authorization', `Bearer ${'x'.repeat(40)}`);
      expect(res.status).toBe(401);
    });

    it('JWT nhân viên không dùng được cho API AI', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/ai/jobs/active')
        .set('x-test-roles', 'nhansu');
      expect(res.status).toBe(401);
    });

    it('đúng API key → 200', async () => {
      repos.get(RecruitmentJob).find.mockResolvedValueOnce([
        {
          id: 3,
          code: 'SALES-CM-01',
          title: 'Nhân viên kinh doanh',
          status: 'ACTIVE',
          screeningCriteria: { requiredSkills: ['sales'] },
          createdBy: 2,
        },
      ]);
      const res = await request(app.getHttpServer())
        .get('/recruitment/ai/jobs/active')
        .set(auth);

      expect(res.status).toBe(200);
      expect(res.body.data[0]).toMatchObject({ id: 3, code: 'SALES-CM-01' });
      expect(res.body.data[0]).not.toHaveProperty('createdBy');
    });
  });

  describe('validation API AI', () => {
    it('khoá lạ trong body → 400 (forbidNonWhitelisted)', async () => {
      const res = await request(app.getHttpServer())
        .post('/recruitment/ai/candidates/find-or-create')
        .set(auth)
        .send({ zaloUserId: '123456', gender: 'male' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain('gender');
    });

    it('metadata chứa thuộc tính nhạy cảm → 400', async () => {
      const res = await request(app.getHttpServer())
        .patch('/recruitment/ai/candidates/7')
        .set(auth)
        .send({ metadata: { gioiTinh: 'nam' } });
      expect(res.status).toBe(400);
    });

    it('enum sai / lương âm / ngày sai định dạng → 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/recruitment/ai/applications/12/screen')
        .set(auth)
        .send({ expectedSalary: -1, availableFrom: '10/10/2026' });
      expect(res.status).toBe(400);

      const handoff = await request(app.getHttpServer())
        .post('/recruitment/ai/applications/12/handoff')
        .set(auth)
        .send({ reason: 'HIRE_NOW', summary: 'x' });
      expect(handoff.status).toBe(400);
    });

    it('id không phải số → 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/ai/applications/abc/context')
        .set(auth);
      expect(res.status).toBe(400);
    });
  });

  describe('idempotency', () => {
    it('find-or-create candidate: retry trả cùng ứng viên', async () => {
      const candidateRepo = repos.get(RecruitmentCandidate);
      candidateRepo.findOne.mockResolvedValue({
        id: 7,
        zaloUserId: '123456',
        fullName: 'Nguyễn Văn A',
        notes: 'nội bộ',
        skills: [],
        metadata: {},
        suspectedDuplicateIds: [],
      });

      const body = {
        zaloUserId: '123456',
        fullName: 'Nguyễn Văn A',
        source: 'ZALO',
      };
      const a = await request(app.getHttpServer())
        .post('/recruitment/ai/candidates/find-or-create')
        .set(auth)
        .send(body);
      const b = await request(app.getHttpServer())
        .post('/recruitment/ai/candidates/find-or-create')
        .set(auth)
        .send(body);

      expect(a.status).toBe(200);
      expect(b.body).toEqual(a.body);
      expect(a.body).toMatchObject({
        outcome: 'EXISTING',
        candidate: { id: 7 },
      });
      expect(a.body.candidate).not.toHaveProperty('notes');
      expect(candidateRepo.save).not.toHaveBeenCalled();
      candidateRepo.findOne.mockResolvedValue(null);
    });

    it('propose interview bắt buộc Idempotency-Key', async () => {
      const res = await request(app.getHttpServer())
        .post('/recruitment/ai/interviews/propose')
        .set(auth)
        .send({ applicationId: 12, slotId: 3 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    });

    it('propose interview retry cùng key → service chỉ chạy một lần', async () => {
      const spy = jest
        .spyOn(interviews, 'aiPropose')
        .mockResolvedValue({
          interview: { id: 70, status: 'PROPOSED' },
        } as any);

      const send = () =>
        request(app.getHttpServer())
          .post('/recruitment/ai/interviews/propose')
          .set(auth)
          .set('Idempotency-Key', 'openclaw-msg-001')
          .send({ applicationId: 12, slotId: 3 });

      const first = await send();
      const second = await send();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(spy).toHaveBeenCalledTimes(1);

      const reused = await request(app.getHttpServer())
        .post('/recruitment/ai/interviews/propose')
        .set(auth)
        .set('Idempotency-Key', 'openclaw-msg-001')
        .send({ applicationId: 12, slotId: 4 });
      expect(reused.status).toBe(422);
      spy.mockRestore();
    });
  });

  describe('API HR — phân quyền & validation', () => {
    it('ban giám đốc xem được danh sách vị trí', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/jobs')
        .set('x-test-roles', 'director');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });
    });

    it('ban giám đốc không tạo được vị trí (chỉ nhansu)', async () => {
      const res = await request(app.getHttpServer())
        .post('/recruitment/jobs')
        .set('x-test-roles', 'director')
        .send({ code: 'SALES-01', title: 'Sales' });
      expect(res.status).toBe(403);
    });

    it('role khác (sales) không xem được', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/applications')
        .set('x-test-roles', 'sales');
      expect(res.status).toBe(403);
    });

    it('tiêu chí sàng lọc nhạy cảm (giới tính, tuổi) bị từ chối → 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/recruitment/jobs')
        .set('x-test-roles', 'nhansu')
        .send({
          code: 'SALES-01',
          title: 'Sales',
          screeningCriteria: {
            requiredSkills: ['sales'],
            gender: 'female',
            maxAge: 30,
          },
        });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/gender|maxAge/);
    });

    it('nhansu tạo vị trí hợp lệ → 201, trạng thái DRAFT', async () => {
      const jobRepo = repos.get(RecruitmentJob);
      jobRepo.save.mockImplementationOnce(async (v: any) => ({ id: 3, ...v }));
      jobRepo.findOne.mockResolvedValueOnce({
        id: 3,
        code: 'SALES-01',
        status: 'DRAFT',
      });

      const res = await request(app.getHttpServer())
        .post('/recruitment/jobs')
        .set('x-test-roles', 'nhansu')
        .send({
          code: 'sales-01',
          title: 'Nhân viên kinh doanh',
          salaryMin: 8000000,
          salaryMax: 15000000,
          screeningCriteria: {
            minimumExperienceMonths: 12,
            requiredSkills: ['sales'],
          },
        });

      expect(res.status).toBe(201);
      expect(jobRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'SALES-01',
          status: 'DRAFT',
          createdBy: 2,
        }),
      );
    });

    it('route /applications/pipeline không bị nuốt vào :id', async () => {
      const res = await request(app.getHttpServer())
        .get('/recruitment/applications/pipeline?status=NEW,SCREENING')
        .set('x-test-roles', 'nhansu');
      expect(res.status).toBe(200);
      expect(res.body.countsByStatus).toMatchObject({ NEW: 0, HIRED: 0 });
    });
  });
});
