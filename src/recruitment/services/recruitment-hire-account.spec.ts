import * as bcrypt from 'bcrypt';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Employee } from '../../employee/employee.entity';
import { EMPLOYEE_POSITIONS } from '../../employee/employee-positions';
import { sanitizeBody } from '../../activity-log/activity-log.util';
import { Teacher } from '../../teaching/entities/teacher.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentConversation } from '../entities/recruitment-conversation.entity';
import { RecruitmentMessage } from '../entities/recruitment-message.entity';
import { RecruitmentActorType, ApplicationStatus } from '../recruitment.enums';
import { AI_ACTOR } from '../recruitment.roles';
import { UpdateApplicationStatusDto } from '../dto/application.dto';
import { createHireAccount } from './recruitment-hire-account';
import { RecruitmentApplicationService } from './recruitment-application.service';
import { RecruitmentJobService } from './recruitment-job.service';

const HR = {
  type: RecruitmentActorType.HR,
  employeeId: 2,
  name: 'Synthetic HR',
  roles: ['nhansu'],
};
const dto = {
  status: ApplicationStatus.HIRED,
  password: 'Synthetic-only-2026',
  confirmAccountRole: true,
  accountPositionRole: 'sales',
};
const repo = (row: any = null) => ({
  exists: jest.fn(async () => false),
  findOne: jest.fn(async () => row),
  find: jest.fn(async () => []),
  create: jest.fn((v) => ({ ...v })),
  save: jest.fn(async (v) => ({ id: 91, ...v })),
  update: jest.fn(),
});
function setup() {
  const candidate = {
    id: 7,
    fullName: 'Synthetic candidate',
    phone: '0900000000',
    email: null,
    employeeId: null,
    deletionRequestedAt: null,
  };
  const job = { id: 3, title: 'Sales', positionRole: 'sales', departmentId: 4 };
  const app: any = {
    id: 12,
    candidateId: 7,
    jobId: 3,
    status: ApplicationStatus.OFFER,
    employeeId: null,
  };
  const repos = new Map<any, any>([
    [RecruitmentCandidate, repo(candidate)],
    [RecruitmentJob, repo(job)],
    [Employee, repo()],
    [Teacher, repo()],
    [RecruitmentApplication, repo(app)],
    [RecruitmentHandoff, repo()],
    [RecruitmentInterview, repo()],
    [RecruitmentConversation, repo()],
    [RecruitmentMessage, repo()],
  ]);
  const em: any = { getRepository: (entity: any) => repos.get(entity) };
  const audit = { record: jest.fn(), recordMandatory: jest.fn() };
  const service = new RecruitmentApplicationService(
    repos.get(RecruitmentApplication),
    repos.get(RecruitmentCandidate),
    repos.get(RecruitmentJob),
    repos.get(RecruitmentHandoff),
    repos.get(RecruitmentInterview),
    repos.get(RecruitmentConversation),
    repos.get(RecruitmentMessage),
    { transaction: async (fn: any) => fn(em) } as any,
    { release: jest.fn() } as any,
    audit as any,
  );
  return { candidate, job, app, repos, em, audit, service };
}

describe('Recruitment hire account', () => {
  it('catalog contains existing system positions, never dev or region/probation flags', () => {
    expect(EMPLOYEE_POSITIONS.map((p) => p.value)).toEqual(
      expect.arrayContaining([
        'sales',
        'nhansu',
        'giaovien_congty',
        'giaovien_ctv',
      ]),
    );
    expect(EMPLOYEE_POSITIONS.map((p) => p.value)).not.toEqual(
      expect.arrayContaining(['dev']),
    );
  });
  it('creates account with selected role, hashed password, department, without copying Zalo identity', async () => {
    const { em, repos } = setup();
    expect(await createHireAccount(em, 7, 3, dto, HR)).toBe(91);
    const saved = repos.get(Employee).save.mock.calls[0][0];
    expect(saved).toMatchObject({
      roles: ['sales'],
      department: { id: 4 },
      phone: '0900000000',
      isActive: true,
    });
    expect(await bcrypt.compare(dto.password, saved.password)).toBe(true);
    expect(saved).not.toHaveProperty('zaloUserId');
    expect(repos.get(RecruitmentCandidate).update).toHaveBeenCalledWith(7, {
      employeeId: 91,
    });
    expect(repos.get(Teacher).save).not.toHaveBeenCalled();
  });
  it.each(['giaovien_congty', 'giaovien_ctv'])(
    'HR hiring %s also creates linked teacher profile',
    async (role) => {
      const { em, repos, job } = setup();
      job.positionRole = role;
      await createHireAccount(
        em,
        7,
        3,
        { ...dto, accountPositionRole: role },
        HR,
      );
      expect(repos.get(Teacher).save).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeId: 91,
          name: 'Synthetic candidate',
        }),
      );
    },
  );
  it.each([
    [
      'missing position',
      (s: any) => (s.job.positionRole = null),
      {},
      'POSITION_REQUIRED',
    ],
    [
      'unknown position',
      (s: any) => (s.job.positionRole = 'dev'),
      {},
      'POSITION_REQUIRED',
    ],
    [
      'missing name',
      (s: any) => (s.candidate.fullName = ''),
      {},
      'ACCOUNT_PROFILE_INCOMPLETE',
    ],
    [
      'missing phone',
      (s: any) => (s.candidate.phone = null),
      {},
      'ACCOUNT_PROFILE_INCOMPLETE',
    ],
    [
      'deletion request',
      (s: any) => (s.candidate.deletionRequestedAt = new Date()),
      {},
      'CANDIDATE_DELETION_PENDING',
    ],
    [
      'already employee',
      (s: any) => (s.candidate.employeeId = 8),
      {},
      'CANDIDATE_ALREADY_EMPLOYEE',
    ],
    [
      'no consent',
      () => {},
      { confirmAccountRole: false },
      'ACCOUNT_ROLE_CONFIRMATION_REQUIRED',
    ],
    [
      'stale role',
      () => {},
      { accountPositionRole: 'director' },
      'ACCOUNT_POSITION_CHANGED',
    ],
    [
      'no password',
      () => {},
      { password: undefined },
      'ACCOUNT_PASSWORD_REQUIRED',
    ],
    [
      'blank password',
      () => {},
      { password: '        ' },
      'ACCOUNT_PASSWORD_REQUIRED',
    ],
    [
      'bcrypt byte truncation',
      () => {},
      { password: 'ế'.repeat(30) },
      'ACCOUNT_PASSWORD_REQUIRED',
    ],
    [
      'existing employee',
      (s: any) => s.repos.get(Employee).findOne.mockResolvedValue({ id: 5 }),
      {},
      'EMPLOYEE_CONTACT_EXISTS',
    ],
    [
      'existing teacher',
      (s: any) => {
        s.job.positionRole = 'giaovien_ctv';
        s.repos.get(Teacher).findOne.mockResolvedValue({ id: 8 });
      },
      { accountPositionRole: 'giaovien_ctv' },
      'TEACHER_CONTACT_EXISTS',
    ],
  ])(
    'blocks %s before creating employee',
    async (_, mutate, overrides, code) => {
      const s = setup();
      (mutate as any)(s);
      await expect(
        createHireAccount(s.em, 7, 3, { ...dto, ...overrides }, HR),
      ).rejects.toMatchObject({ response: { code } });
      expect(s.repos.get(Employee).save).not.toHaveBeenCalled();
    },
  );
  it.each([AI_ACTOR, { ...HR, roles: ['director'] }])(
    'AI/non-HR cannot grant an account',
    async (actor) => {
      const s = setup();
      await expect(
        createHireAccount(s.em, 7, 3, dto, actor),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        s.service.changeStatus(12, dto, actor),
      ).rejects.toMatchObject({ status: 403 });
      expect(s.repos.get(Employee).save).not.toHaveBeenCalled();
    },
  );
  it('HIRED links application and candidate and audits account creation without secrets', async () => {
    const s = setup();
    await s.service.changeStatus(12, dto, HR);
    expect(s.app).toMatchObject({ employeeId: 91, status: 'HIRED' });
    expect(s.audit.recordMandatory).toHaveBeenCalledWith(
      s.em,
      expect.objectContaining({
        action: 'APPLICATION_ACCOUNT_CREATE',
        context: { employeeId: 91, candidateId: 7, positionRole: 'sales' },
      }),
    );
    expect(JSON.stringify(s.audit.recordMandatory.mock.calls)).not.toContain(
      dto.password,
    );
    expect(sanitizeBody(dto).password).toBe('***');
  });
  it('same hired application retry returns account without changing password/roles', async () => {
    const s = setup();
    s.app.status = ApplicationStatus.HIRED;
    s.app.employeeId = 91;
    expect(await s.service.changeStatus(12, dto, HR)).toMatchObject({
      employeeId: 91,
    });
    expect(s.repos.get(Employee).save).not.toHaveBeenCalled();
    expect(s.audit.recordMandatory).not.toHaveBeenCalled();
  });
  it('legacy HIRED records do not silently provision accounts', async () => {
    const s = setup();
    s.app.status = ApplicationStatus.HIRED;
    await expect(s.service.changeStatus(12, dto, HR)).rejects.toMatchObject({
      response: { code: 'LEGACY_HIRE_ACCOUNT_REQUIRED' },
    });
  });
  it('no account on application submission/screening or invalid hire transition', async () => {
    const s = setup();
    s.app.status = ApplicationStatus.NEW;
    await expect(s.service.changeStatus(12, dto, HR)).rejects.toMatchObject({
      response: { code: 'INVALID_STATUS_TRANSITION' },
    });
    expect(s.repos.get(Employee).save).not.toHaveBeenCalled();
    await expect(
      s.service.changeStatus(
        12,
        { ...dto, status: ApplicationStatus.SCREENING },
        HR,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('DTO prevents arbitrary account grants and enforces password length', async () => {
    const errors = await validate(
      plainToInstance(UpdateApplicationStatusDto, {
        ...dto,
        password: '123',
        roles: ['director'],
        employeeId: 10,
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(errors.map((e) => e.property)).toEqual(
      expect.arrayContaining(['password', 'roles', 'employeeId']),
    );
  });
  it('job creation requires a catalog entry; existing jobs can be mapped explicitly', async () => {
    const jobs: any = repo({ id: 3, code: 'TEST', status: 'DRAFT' });
    const service = new RecruitmentJobService(
      jobs,
      repo() as any,
      { record: jest.fn() } as any,
    );
    await expect(
      service.create({ code: 'TEST', title: 'Test' }, HR),
    ).rejects.toMatchObject({ response: { code: 'POSITION_REQUIRED' } });
    await service.create(
      { code: 'NEW', title: 'Tên đăng tuyển', positionRole: 'sales' },
      HR,
    );
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ positionRole: 'sales' }),
    );
    await service.update(3, { positionRole: 'giaovien_ctv' }, HR);
    expect(jobs.save).toHaveBeenCalledWith(
      expect.objectContaining({ positionRole: 'giaovien_ctv' }),
    );
    await expect(
      service.update(3, { positionRole: 'dev' }, HR),
    ).rejects.toMatchObject({ response: { code: 'POSITION_REQUIRED' } });
  });
});
