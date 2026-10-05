import { BadRequestException, ConflictException } from '@nestjs/common';

import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import {
  ApplicationStatus,
  CandidateSource,
  HandoffStatus,
  InterviewStatus,
  RecruitmentActorType,
  RecruitmentJobStatus,
} from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentApplicationService } from './recruitment-application.service';

const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 2,
  name: 'Nhân sự',
  roles: ['nhansu'],
};

function repo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    findOneOrFail: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 30, ...v })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as any;
}

function setup() {
  const applicationRepo = repo();
  const candidateRepo = repo();
  const jobRepo = repo();
  const handoffRepo = repo();
  const interviewRepo = repo();
  const conversationRepo = repo();
  const messageRepo = repo();

  const txRepos = new Map<unknown, any>([
    [RecruitmentApplication, applicationRepo],
    [RecruitmentHandoff, handoffRepo],
    [RecruitmentInterview, interviewRepo],
  ]);
  const em = { getRepository: (entity: unknown) => txRepos.get(entity) };
  const dataSource = { transaction: jest.fn(async (cb) => cb(em)) } as any;
  const slots = {
    release: jest.fn(),
    reserve: jest.fn(),
    listAvailable: jest.fn(),
  };
  const audit = { record: jest.fn() } as any;

  candidateRepo.findOne.mockResolvedValue({
    id: 7,
    source: CandidateSource.ZALO,
    aiStoppedAt: null,
    skills: [],
  });
  jobRepo.findOne.mockResolvedValue({
    id: 3,
    status: RecruitmentJobStatus.ACTIVE,
  });

  const service = new RecruitmentApplicationService(
    applicationRepo,
    candidateRepo,
    jobRepo,
    handoffRepo,
    interviewRepo,
    conversationRepo,
    messageRepo,
    dataSource,
    slots,
    audit,
  );
  return {
    service,
    applicationRepo,
    candidateRepo,
    jobRepo,
    handoffRepo,
    interviewRepo,
    slots,
    audit,
  };
}

describe('RecruitmentApplicationService', () => {
  it('HR tạo hồ sơ NEW cho vị trí đang mở', async () => {
    const { service, applicationRepo, audit } = setup();
    applicationRepo.findOne
      .mockResolvedValueOnce(null) // chưa có hồ sơ còn hiệu lực
      .mockResolvedValueOnce({
        id: 30,
        status: ApplicationStatus.NEW,
        candidateId: 7,
        jobId: 3,
      });

    const result = await service.create({ candidateId: 7, jobId: 3 }, HR);

    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: 7,
        jobId: 3,
        status: ApplicationStatus.NEW,
      }),
    );
    expect(result).toMatchObject({ id: 30, status: ApplicationStatus.NEW });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'APPLICATION_CREATE' }),
    );
  });

  it('trùng hồ sơ còn hiệu lực → 409 APPLICATION_EXISTS', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne.mockResolvedValueOnce({
      id: 12,
      status: ApplicationStatus.SCREENING,
    });

    await expect(
      service.create({ candidateId: 7, jobId: 3 }, HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'APPLICATION_EXISTS',
        applicationId: 12,
      }),
    });
    expect(applicationRepo.save).not.toHaveBeenCalled();
  });

  it('AI find-or-create: retry trả lại hồ sơ cũ, không tạo thêm', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne.mockResolvedValueOnce({
      id: 12,
      candidateId: 7,
      jobId: 3,
      status: ApplicationStatus.COLLECTING_INFO,
      aiPaused: false,
    });

    const result = await service.aiFindOrCreate({ candidateId: 7, jobId: 3 });

    expect(result).toMatchObject({ created: false, application: { id: 12 } });
    expect(applicationRepo.save).not.toHaveBeenCalled();
  });

  it('AI find-or-create: race 23505 → trả hồ sơ request kia vừa tạo', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 44,
        candidateId: 7,
        jobId: 3,
        status: ApplicationStatus.NEW,
      });
    applicationRepo.save.mockRejectedValueOnce({ code: '23505' });

    const result = await service.aiFindOrCreate({ candidateId: 7, jobId: 3 });
    expect(result).toMatchObject({ created: false, application: { id: 44 } });
  });

  it('AI không tạo hồ sơ cho vị trí đã tạm dừng', async () => {
    const { service, jobRepo } = setup();
    jobRepo.findOne.mockResolvedValue({
      id: 3,
      status: RecruitmentJobStatus.PAUSED,
    });

    await expect(
      service.aiFindOrCreate({ candidateId: 7, jobId: 3 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'JOB_NOT_ACTIVE' }),
    });
  });

  it('HR chuyển trạng thái hợp lệ (INTERVIEW → OFFER), ghi người duyệt + audit', async () => {
    const { service, applicationRepo, audit } = setup();
    const app = {
      id: 12,
      candidateId: 7,
      jobId: 3,
      status: ApplicationStatus.INTERVIEW,
    };
    applicationRepo.findOne.mockResolvedValue(app);

    await service.changeStatus(12, { status: ApplicationStatus.OFFER }, HR);

    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ApplicationStatus.OFFER,
        reviewedBy: 2,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'APPLICATION_STATUS_CHANGE',
        context: expect.objectContaining({ from: 'INTERVIEW', to: 'OFFER' }),
      }),
    );
  });

  it('chuyển trạng thái sai luồng (NEW → HIRED) → 409, không lưu', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne.mockResolvedValue({
      id: 12,
      status: ApplicationStatus.NEW,
    });

    await expect(
      service.changeStatus(12, { status: ApplicationStatus.HIRED }, HR),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(applicationRepo.save).not.toHaveBeenCalled();
  });

  it('loại hồ sơ phải có lý do', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne.mockResolvedValue({
      id: 12,
      status: ApplicationStatus.SCREENING,
    });

    await expect(
      service.changeStatus(12, { status: ApplicationStatus.REJECTED }, HR),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('loại hồ sơ: huỷ lịch phỏng vấn đang treo, trả chỗ slot, đóng yêu cầu HR', async () => {
    const { service, applicationRepo, interviewRepo, handoffRepo, slots } =
      setup();
    applicationRepo.findOne.mockResolvedValue({
      id: 12,
      status: ApplicationStatus.INTERVIEW,
    });
    interviewRepo.find.mockResolvedValue([
      {
        id: 5,
        applicationId: 12,
        slotId: 9,
        status: InterviewStatus.CONFIRMED,
      },
    ]);

    await service.changeStatus(
      12,
      {
        status: ApplicationStatus.REJECTED,
        rejectedReason: 'Không phù hợp văn hoá',
      },
      HR,
    );

    expect(interviewRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5, status: InterviewStatus.CANCELLED }),
    );
    expect(slots.release).toHaveBeenCalledWith(expect.anything(), 9);
    expect(handoffRepo.update).toHaveBeenCalledWith(
      { applicationId: 12, status: HandoffStatus.OPEN },
      expect.objectContaining({ status: HandoffStatus.RESOLVED }),
    );
  });

  it('HR trả lại cho AI: mở khoá, về COLLECTING_INFO, handoff → RETURNED_TO_AI', async () => {
    const { service, applicationRepo, handoffRepo } = setup();
    applicationRepo.findOne.mockResolvedValue({
      id: 12,
      candidateId: 7,
      status: ApplicationStatus.NEEDS_HR_REVIEW,
      aiPaused: true,
    });

    await service.resumeAi(12, { note: 'Đã thống nhất lương' }, HR);

    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        aiPaused: false,
        status: ApplicationStatus.COLLECTING_INFO,
      }),
    );
    expect(handoffRepo.update).toHaveBeenCalledWith(
      { applicationId: 12, status: HandoffStatus.OPEN },
      expect.objectContaining({ status: HandoffStatus.RETURNED_TO_AI }),
    );
  });

  it('không trả lại cho AI khi ứng viên đã xin xoá dữ liệu', async () => {
    const { service, applicationRepo, candidateRepo } = setup();
    applicationRepo.findOne.mockResolvedValue({
      id: 12,
      candidateId: 7,
      status: ApplicationStatus.NEEDS_HR_REVIEW,
      aiPaused: true,
    });
    candidateRepo.findOne.mockResolvedValue({ id: 7, aiStoppedAt: new Date() });

    await expect(service.resumeAi(12, {}, HR)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_STOPPED_FOR_CANDIDATE' }),
    });
  });
});
