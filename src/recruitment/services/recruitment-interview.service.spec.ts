import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import {
  ApplicationStatus,
  InterviewStatus,
  RecruitmentActorType,
} from '../recruitment.enums';
import { RecruitmentInterviewService } from './recruitment-interview.service';

const future = new Date(Date.now() + 3 * 86_400_000);
const futureEnd = new Date(future.getTime() + 30 * 60_000);

function setup(app: Record<string, unknown>) {
  const interviewRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 70, ...v })),
  } as any;
  const applicationRepo = {
    findOne: jest.fn().mockResolvedValue(app),
    save: jest.fn(async (v) => v),
  } as any;
  const candidateRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 7, aiStoppedAt: null }),
  } as any;
  const repos = new Map<unknown, any>([
    [RecruitmentInterview, interviewRepo],
    [RecruitmentApplication, applicationRepo],
  ]);
  const em = { getRepository: (e: unknown) => repos.get(e) };
  const dataSource = { transaction: jest.fn(async (cb) => cb(em)) } as any;
  const slots = {
    listAvailable: jest.fn().mockResolvedValue([]),
    reserve: jest.fn().mockResolvedValue({
      id: 3,
      interviewerId: 15,
      startAt: future,
      endAt: futureEnd,
      timezone: 'Asia/Ho_Chi_Minh',
      location: 'Văn phòng Cà Mau',
      meetingUrl: null,
    }),
    release: jest.fn(),
  };
  const audit = { record: jest.fn() } as any;
  const service = new RecruitmentInterviewService(
    interviewRepo,
    {} as any,
    applicationRepo,
    candidateRepo,
    { findOne: jest.fn() } as any,
    { exists: jest.fn().mockResolvedValue(true) } as any,
    dataSource,
    slots,
    audit,
  );
  return { service, interviewRepo, applicationRepo, slots, audit };
}

const qualified = {
  id: 12,
  candidateId: 7,
  jobId: 3,
  status: ApplicationStatus.QUALIFIED,
  aiPaused: false,
};

describe('RecruitmentInterviewService — AI', () => {
  it('đề xuất lịch: giữ chỗ trong slot HR mở, lịch PROPOSED, hồ sơ chưa đổi trạng thái', async () => {
    const { service, slots, interviewRepo, applicationRepo, audit } = setup({
      ...qualified,
    });

    const result = await service.aiPropose({ applicationId: 12, slotId: 3 });

    expect(slots.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ slotId: 3, jobId: 3, minLeadMinutes: 60 }),
    );
    expect(interviewRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        slotId: 3,
        scheduledStart: future,
        status: InterviewStatus.PROPOSED,
        createdByType: RecruitmentActorType.AI,
      }),
    );
    expect(result.interview).toMatchObject({
      id: 70,
      status: InterviewStatus.PROPOSED,
    });
    expect(applicationRepo.save).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INTERVIEW_PROPOSE' }),
    );
  });

  it('hồ sơ chưa QUALIFIED → không đề xuất được', async () => {
    const { service, slots } = setup({
      ...qualified,
      status: ApplicationStatus.SCREENING,
    });

    await expect(
      service.aiPropose({ applicationId: 12, slotId: 3 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INTERVIEW_NOT_ALLOWED' }),
    });
    expect(slots.reserve).not.toHaveBeenCalled();
  });

  it('đã có lịch đang chờ → 409 ACTIVE_INTERVIEW_EXISTS', async () => {
    const { service, interviewRepo } = setup({ ...qualified });
    interviewRepo.findOne.mockResolvedValue({
      id: 55,
      status: InterviewStatus.PROPOSED,
    });

    await expect(
      service.aiPropose({ applicationId: 12, slotId: 3 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'ACTIVE_INTERVIEW_EXISTS',
        interviewId: 55,
      }),
    });
  });

  it('ứng viên xác nhận → CONFIRMED và hồ sơ QUALIFIED → INTERVIEW', async () => {
    const { service, interviewRepo, applicationRepo } = setup({ ...qualified });
    interviewRepo.findOne.mockResolvedValue({
      id: 70,
      applicationId: 12,
      status: InterviewStatus.PROPOSED,
      scheduledStart: future,
      scheduledEnd: futureEnd,
    });

    const result = await service.aiConfirm(70);

    expect(result).toMatchObject({
      alreadyConfirmed: false,
      interview: { status: InterviewStatus.CONFIRMED },
      application: { id: 12, status: ApplicationStatus.INTERVIEW },
    });
    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: ApplicationStatus.INTERVIEW }),
    );
  });

  it('xác nhận lại (retry) → trả nguyên trạng, không ghi', async () => {
    const { service, interviewRepo, applicationRepo } = setup({
      ...qualified,
      status: ApplicationStatus.INTERVIEW,
    });
    interviewRepo.findOne.mockResolvedValue({
      id: 70,
      applicationId: 12,
      status: InterviewStatus.CONFIRMED,
      scheduledStart: future,
    });

    const result = await service.aiConfirm(70);
    expect(result.alreadyConfirmed).toBe(true);
    expect(applicationRepo.save).not.toHaveBeenCalled();
  });

  it('hồ sơ đã chuyển HR → AI không xác nhận được', async () => {
    const { service, interviewRepo } = setup({ ...qualified, aiPaused: true });
    interviewRepo.findOne.mockResolvedValue({
      id: 70,
      applicationId: 12,
      status: InterviewStatus.PROPOSED,
      scheduledStart: future,
    });

    await expect(service.aiConfirm(70)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_PAUSED_FOR_HR' }),
    });
  });
});
