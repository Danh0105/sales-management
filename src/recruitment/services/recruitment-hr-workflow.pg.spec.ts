import { resolve } from 'path';
import { DataSource } from 'typeorm';
import { Employee } from '../../employee/employee.entity';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentInterviewSlot } from '../entities/recruitment-interview-slot.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { InterviewStatus, RecruitmentActorType } from '../recruitment.enums';
import { DbInterviewSlotProvider } from './interview-slot.provider';
import { RecruitmentInterviewService } from './recruitment-interview.service';
import { RecruitmentAuditService } from '../recruitment-audit.service';

const url = process.env.RECRUITMENT_HR_TEST_PG_URL;
if (url && !new URL(url).pathname.startsWith('/g8_hr_test')) {
  throw new Error(
    'HR integration test requires an isolated g8_hr_test database',
  );
}
const suite = url ? describe : describe.skip;
suite('HR interview workflow — isolated PostgreSQL', () => {
  let ds: DataSource;
  let appDs: DataSource;
  let service: RecruitmentInterviewService;
  let slots: DbInterviewSlotProvider;
  const audit = { recordMandatory: jest.fn(), record: jest.fn() };
  const mandatoryAudit = new RecruitmentAuditService({} as any);
  const actor = {
    type: RecruitmentActorType.HR,
    employeeId: 99999,
    name: 'Synthetic HR',
    roles: ['nhansu'],
  };
  beforeAll(async () => {
    ds = await new DataSource({
      type: 'postgres',
      url,
      database: new URL(url!).pathname.slice(1),
      entities: [resolve(__dirname, '../../**/*.entity.ts')],
      synchronize: false,
    }).initialize();
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
    slots = new DbInterviewSlotProvider(
      appDs.getRepository(RecruitmentInterviewSlot),
    );
    service = new RecruitmentInterviewService(
      appDs.getRepository(RecruitmentInterview),
      appDs.getRepository(RecruitmentInterviewSlot),
      appDs.getRepository(RecruitmentApplication),
      appDs.getRepository(RecruitmentCandidate),
      appDs.getRepository(RecruitmentJob),
      appDs.getRepository(Employee),
      appDs,
      slots,
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
        mandatoryAudit.recordMandatory(em, params),
      );
    await ds.query(
      `DELETE FROM activity_log WHERE resource LIKE 'recruitment-%'`,
    );
    await ds.query(
      `TRUNCATE recruitment_interviews, recruitment_interview_slots, recruitment_applications, recruitment_candidates, recruitment_jobs RESTART IDENTITY CASCADE`,
    );
    await ds.query(`INSERT INTO recruitment_jobs(code,title,status) VALUES ('HR-TEST','Synthetic job','ACTIVE');
      INSERT INTO recruitment_candidates(full_name,source) VALUES ('Synthetic candidate','MANUAL');
      INSERT INTO recruitment_applications(candidate_id,job_id,status) VALUES (1,1,'QUALIFIED');
      INSERT INTO recruitment_interview_slots(start_at,end_at,capacity,booked_count) VALUES (now()+interval '2 days',now()+interval '2 days 1 hour',2,1);`);
  });

  it('slot edits wait for concurrent reservations and enforce current booked count', async () => {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await slots.reserve(qr.manager, {
        slotId: 1,
        jobId: 1,
        minLeadMinutes: 0,
      });
      let settled = false;
      const edit = service
        .updateSlot(1, { capacity: 1 }, actor)
        .then(
          () => 'saved',
          () => 'blocked',
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await qr.commitTransaction();
      expect(await edit).toBe('blocked');
      const row = await ds
        .getRepository(RecruitmentInterviewSlot)
        .findOneByOrFail({ id: 1 });
      expect([row.capacity, row.bookedCount]).toEqual([2, 2]);
    } finally {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('two concurrent cancellations release the same booked place only once', async () => {
    await ds.query(`UPDATE recruitment_interview_slots SET booked_count=2 WHERE id=1;
      INSERT INTO recruitment_interviews(application_id,candidate_id,job_id,slot_id,scheduled_start,scheduled_end,status,created_by_type)
      VALUES (1,1,1,1,now()+interval '2 days',now()+interval '2 days 1 hour','CONFIRMED','HR');`);
    await Promise.all([
      service.update(
        1,
        {
          status: InterviewStatus.CANCELLED,
          cancellationReason: 'Synthetic cancellation A',
        },
        actor,
      ),
      service.update(
        1,
        {
          status: InterviewStatus.CANCELLED,
          cancellationReason: 'Synthetic cancellation B',
        },
        actor,
      ),
    ]);
    expect(
      (
        await ds
          .getRepository(RecruitmentInterviewSlot)
          .findOneByOrFail({ id: 1 })
      ).bookedCount,
    ).toBe(1);
    expect((await service.findOne(1)).allowedNextStatuses).toEqual([]);
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM activity_log WHERE method='INTERVIEW_UPDATE'`,
    );
    expect(n).toBe(2);
  });

  it('audit failure rolls slot changes back', async () => {
    audit.recordMandatory.mockRejectedValueOnce(
      new Error('synthetic audit failure'),
    );
    await expect(
      service.updateSlot(1, { isActive: false }, actor),
    ).rejects.toThrow('synthetic audit failure');
    expect(
      (
        await ds
          .getRepository(RecruitmentInterviewSlot)
          .findOneByOrFail({ id: 1 })
      ).isActive,
    ).toBe(true);
  });

  it('AI confirmation waits for an HR cancellation and cannot revive the cancelled interview', async () => {
    await ds.query(`INSERT INTO recruitment_interviews(application_id,candidate_id,job_id,slot_id,scheduled_start,scheduled_end,status,created_by_type)
      VALUES (1,1,1,1,now()+interval '2 days',now()+interval '2 days 1 hour','PROPOSED','AI');`);
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `UPDATE recruitment_interviews SET status='CANCELLED', cancellation_reason='Synthetic HR cancellation' WHERE id=1`,
      );
      let settled = false;
      const confirm = service
        .aiConfirm(1)
        .then(
          () => 'confirmed',
          (error) => error.response?.code,
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      await qr.commitTransaction();
      expect(await confirm).toBe('INTERVIEW_NOT_PROPOSED');
      expect((await service.findOne(1)).status).toBe(InterviewStatus.CANCELLED);
      expect(
        (
          await ds
            .getRepository(RecruitmentApplication)
            .findOneByOrFail({ id: 1 })
        ).status,
      ).toBe('QUALIFIED');
    } finally {
      if (qr.isTransactionActive) await qr.rollbackTransaction();
      await qr.release();
    }
  });

  it('AI confirmation audit failure rolls back both interview and application', async () => {
    await ds.query(`INSERT INTO recruitment_interviews(application_id,candidate_id,job_id,slot_id,scheduled_start,scheduled_end,status,created_by_type)
      VALUES (1,1,1,1,now()+interval '2 days',now()+interval '2 days 1 hour','PROPOSED','AI');`);
    audit.recordMandatory.mockRejectedValueOnce(
      new Error('synthetic AI audit failure'),
    );
    await expect(service.aiConfirm(1)).rejects.toThrow(
      'synthetic AI audit failure',
    );
    expect((await service.findOne(1)).status).toBe(InterviewStatus.PROPOSED);
    expect(
      (
        await ds
          .getRepository(RecruitmentApplication)
          .findOneByOrFail({ id: 1 })
      ).status,
    ).toBe('QUALIFIED');
  });
});
