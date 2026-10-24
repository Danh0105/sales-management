import { resolve } from 'path';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { RecruitmentHireAccounts1794100000000 } from '../../migrations/1794100000000-RecruitmentHireAccounts';
import { Employee } from '../../employee/employee.entity';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentInterviewSlot } from '../entities/recruitment-interview-slot.entity';
import { RecruitmentConversation } from '../entities/recruitment-conversation.entity';
import { RecruitmentMessage } from '../entities/recruitment-message.entity';
import { RecruitmentActorType, ApplicationStatus } from '../recruitment.enums';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import { RecruitmentApplicationService } from './recruitment-application.service';
import { DbInterviewSlotProvider } from './interview-slot.provider';

const url = process.env.RECRUITMENT_HR_TEST_PG_URL;
if (url && !new URL(url).pathname.startsWith('/g8_hr_test'))
  throw new Error('Requires isolated g8_hr_test database');
const suite = url ? describe : describe.skip;
suite('Hire account — isolated PostgreSQL, application permissions', () => {
  let ds: DataSource;
  let appDs: DataSource;
  let service: RecruitmentApplicationService;
  const realAudit = new RecruitmentAuditService({} as any);
  const audit = { record: jest.fn(), recordMandatory: jest.fn() };
  const actor = {
    type: RecruitmentActorType.HR,
    employeeId: 99999,
    name: 'Synthetic HR',
    roles: ['nhansu'],
  };
  const dto = {
    status: ApplicationStatus.HIRED,
    password: 'Synthetic-only-2026',
    confirmAccountRole: true,
    accountPositionRole: 'sales',
  };
  const migration = new RecruitmentHireAccounts1794100000000();
  beforeAll(async () => {
    ds = await new DataSource({
      type: 'postgres',
      url,
      database: new URL(url!).pathname.slice(1),
      entities: [resolve(__dirname, '../../**/*.entity.ts')],
      synchronize: false,
    }).initialize();
    const [{ exists }] = await ds.query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='recruitment_jobs' AND column_name='position_role')`,
    );
    if (!exists) {
      const runner = ds.createQueryRunner();
      try {
        await migration.up(runner);
      } finally {
        await runner.release();
      }
    }
    const appUrl = new URL(url!);
    appUrl.username = 'sales_app';
    appUrl.password = '';
    appDs = await new DataSource({
      type: 'postgres',
      url: appUrl.toString(),
      database: appUrl.pathname.slice(1),
      entities: [resolve(__dirname, '../../**/*.entity.ts')],
      synchronize: false,
    }).initialize();
    service = new RecruitmentApplicationService(
      appDs.getRepository(RecruitmentApplication),
      appDs.getRepository(RecruitmentCandidate),
      appDs.getRepository(RecruitmentJob),
      appDs.getRepository(RecruitmentHandoff),
      appDs.getRepository(RecruitmentInterview),
      appDs.getRepository(RecruitmentConversation),
      appDs.getRepository(RecruitmentMessage),
      appDs,
      new DbInterviewSlotProvider(
        appDs.getRepository(RecruitmentInterviewSlot),
      ),
      audit as any,
    );
  });
  afterAll(async () => {
    await appDs?.destroy();
    await ds?.destroy();
  });
  beforeEach(async () => {
    audit.recordMandatory
      .mockReset()
      .mockImplementation((em, params) =>
        realAudit.recordMandatory(em, params),
      );
    // Chỉ DB Docker schema-only; không bao giờ chạy suite này trên sales_db.
    await ds.query(
      `TRUNCATE employee, recruitment_candidates, recruitment_jobs RESTART IDENTITY CASCADE`,
    );
    await ds.query(
      `DELETE FROM activity_log WHERE resource LIKE 'recruitment-%'`,
    );
    await ds.query(`INSERT INTO employee(id,name,roles) VALUES (99999,'Synthetic HR',ARRAY['nhansu']);
      INSERT INTO recruitment_jobs(code,title,status,position_role) VALUES ('HIRE-TEST','Synthetic job','ACTIVE','sales');
      INSERT INTO recruitment_candidates(full_name,phone,email,source) VALUES ('Synthetic candidate','0900000000','synthetic@example.invalid','MANUAL');
      INSERT INTO recruitment_applications(candidate_id,job_id,status) VALUES (1,1,'OFFER');`);
  });
  it('creates usable hashed credential with correct role and linked candidate/application, audit has no credential', async () => {
    const result = await service.changeStatus(1, dto, actor);
    expect(result).toMatchObject({
      status: 'HIRED',
      employeeId: expect.any(Number),
      candidate: { employeeId: result.employeeId },
    });
    const employee = await appDs
      .getRepository(Employee)
      .findOneByOrFail({ id: result.employeeId! });
    expect(employee.roles).toEqual(['sales']);
    expect(await bcrypt.compare(dto.password, employee.password!)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('password');
    const logs = await ds.query(
      `SELECT context, "beforeData", "afterData" FROM activity_log WHERE method IN ('APPLICATION_ACCOUNT_CREATE','APPLICATION_STATUS_CHANGE')`,
    );
    expect(logs).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(dto.password);
    expect(JSON.stringify(logs)).not.toContain(employee.password);
  });
  it('concurrent hire of same application is idempotent and creates exactly one employee', async () => {
    const results = await Promise.all([
      service.changeStatus(1, dto, actor),
      service.changeStatus(1, dto, actor),
    ]);
    expect(results[0].employeeId).toBe(results[1].employeeId);
    expect(
      await ds.query(`SELECT id FROM employee WHERE phone='0900000000'`),
    ).toHaveLength(1);
    expect(
      await ds.query(
        `SELECT id FROM activity_log WHERE method='APPLICATION_ACCOUNT_CREATE'`,
      ),
    ).toHaveLength(1);
  });
  it('two applications of one candidate cannot provision two accounts or auto-add roles', async () => {
    await ds.query(`INSERT INTO recruitment_jobs(code,title,status,position_role) VALUES ('SECOND','Synthetic second job','ACTIVE','director');
      INSERT INTO recruitment_applications(candidate_id,job_id,status) VALUES (1,2,'OFFER');`);
    const results = await Promise.allSettled([
      service.changeStatus(1, dto, actor),
      service.changeStatus(
        2,
        { ...dto, accountPositionRole: 'director' },
        actor,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await ds.query(`SELECT id FROM employee WHERE phone='0900000000'`),
    ).toHaveLength(1);
    expect(
      await ds.query(
        `SELECT id FROM recruitment_applications WHERE status='HIRED'`,
      ),
    ).toHaveLength(1);
  });
  it('audit failure rolls back employee, teacher, candidate link and hired status', async () => {
    await ds.query(
      `UPDATE recruitment_jobs SET position_role='giaovien_ctv' WHERE id=1`,
    );
    audit.recordMandatory.mockRejectedValueOnce(
      new Error('Synthetic audit failure'),
    );
    await expect(
      service.changeStatus(
        1,
        { ...dto, accountPositionRole: 'giaovien_ctv' },
        actor,
      ),
    ).rejects.toThrow('Synthetic audit failure');
    expect(
      await ds.query(`SELECT id FROM employee WHERE phone='0900000000'`),
    ).toHaveLength(0);
    expect(
      await ds.query(`SELECT id FROM teachers WHERE phone='0900000000'`),
    ).toHaveLength(0);
    expect(
      await ds.query(
        `SELECT status, employee_id FROM recruitment_applications WHERE id=1`,
      ),
    ).toEqual([{ status: 'OFFER', employee_id: null }]);
    expect(
      await ds.query(
        `SELECT employee_id FROM recruitment_candidates WHERE id=1`,
      ),
    ).toEqual([{ employee_id: null }]);
  });
  it('teacher hire creates profile and account together without linking recruitment OA identity', async () => {
    await ds.query(`UPDATE recruitment_jobs SET position_role='giaovien_congty' WHERE id=1;
      UPDATE recruitment_candidates SET zalo_oa_id='synthetic-recruitment-oa',zalo_user_id='synthetic-sender' WHERE id=1`);
    const result = await service.changeStatus(
      1,
      { ...dto, accountPositionRole: 'giaovien_congty' },
      actor,
    );
    const [teacher] = await ds.query(
      `SELECT employee_id, zalo_user_id FROM teachers WHERE phone='0900000000'`,
    );
    expect(teacher).toEqual({
      employee_id: result.employeeId,
      zalo_user_id: null,
    });
    expect(
      (
        await appDs
          .getRepository(Employee)
          .findOneByOrFail({ id: result.employeeId! })
      ).roles,
    ).toEqual(['giaovien_congty']);
  });
  it('existing employee, case-insensitive email collision does not link or change their password/roles', async () => {
    await ds.query(
      `INSERT INTO employee(name,phone,email,roles) VALUES ('Synthetic existing','0900000001','SYNTHETIC@example.invalid',ARRAY['director'])`,
    );
    await expect(service.changeStatus(1, dto, actor)).rejects.toMatchObject({
      response: { code: 'EMPLOYEE_CONTACT_EXISTS' },
    });
    expect(
      await ds.query(
        `SELECT status, employee_id FROM recruitment_applications WHERE id=1`,
      ),
    ).toEqual([{ status: 'OFFER', employee_id: null }]);
  });
  it('migration refuses rollback after linking real accounts', async () => {
    await service.changeStatus(1, dto, actor);
    const runner = ds.createQueryRunner();
    try {
      await expect(migration.down(runner)).rejects.toThrow(
        'REFUSING_TO_DROP_HIRE_ACCOUNT_LINKS',
      );
    } finally {
      await runner.release();
    }
  });
  it('stale application writer cannot erase the account or revert a completed hire', async () => {
    const stale = await appDs
      .getRepository(RecruitmentApplication)
      .findOneByOrFail({ id: 1 });
    const hired = await service.changeStatus(1, dto, actor);
    await expect(
      appDs.getRepository(RecruitmentApplication).save(stale),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await ds.query(
        `SELECT status, employee_id FROM recruitment_applications WHERE id=1`,
      ),
    ).toEqual([{ status: 'HIRED', employee_id: hired.employeeId }]);
    await expect(
      ds.query(`UPDATE recruitment_applications SET status='OFFER' WHERE id=1`),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('stale candidate writer cannot unlink the employee created by HR', async () => {
    const stale = await appDs
      .getRepository(RecruitmentCandidate)
      .findOneByOrFail({ id: 1 });
    const hired = await service.changeStatus(1, dto, actor);
    await expect(
      appDs.getRepository(RecruitmentCandidate).save(stale),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await ds.query(
        `SELECT employee_id FROM recruitment_candidates WHERE id=1`,
      ),
    ).toEqual([{ employee_id: hired.employeeId }]);
  });
  it('unused migration can roll back and reapply without deleting employees or old hires', async () => {
    const runner = ds.createQueryRunner();
    try {
      await migration.down(runner);
      expect(
        await ds.query(`SELECT id FROM employee WHERE id=99999`),
      ).toHaveLength(1);
      await migration.up(runner);
      expect(
        await ds.query(`SELECT position_role FROM recruitment_jobs WHERE id=1`),
      ).toEqual([{ position_role: null }]);
    } finally {
      await runner.release();
    }
  });
});
