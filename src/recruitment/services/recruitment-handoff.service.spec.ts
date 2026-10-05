import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import {
  ApplicationStatus,
  HandoffPriority,
  HandoffReason,
  HandoffStatus,
  RecruitmentActorType,
} from '../recruitment.enums';
import { CandidatePrivacyService } from './candidate-privacy.service';
import { RecruitmentHandoffService } from './recruitment-handoff.service';

function setup(app: Record<string, unknown>) {
  const applicationRepo = {
    findOne: jest.fn().mockResolvedValue(app),
    findOneOrFail: jest.fn().mockResolvedValue(app),
    find: jest.fn().mockResolvedValue([app]),
    save: jest.fn(async (v) => v),
  } as any;
  const candidateRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue({
        id: 7,
        deletionRequestedAt: null,
        aiStoppedAt: null,
      }),
    save: jest.fn(async (v) => v),
  } as any;
  const handoffRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: 61, createdAt: new Date(), ...v })),
  } as any;
  const repos = new Map<unknown, any>([
    [RecruitmentApplication, applicationRepo],
    [RecruitmentCandidate, candidateRepo],
    [RecruitmentHandoff, handoffRepo],
  ]);
  const em: any = { getRepository: (e: unknown) => repos.get(e) };
  handoffRepo.manager = em;
  const dataSource = {
    transaction: jest.fn(async (cb) => cb(em)),
    manager: em,
    getRepository: (e: unknown) => repos.get(e),
  } as any;
  const audit = { record: jest.fn() } as any;

  const privacy = new CandidatePrivacyService(candidateRepo, dataSource, audit);
  const service = new RecruitmentHandoffService(
    handoffRepo,
    applicationRepo,
    dataSource,
    privacy,
    audit,
  );
  return { service, applicationRepo, candidateRepo, handoffRepo, audit };
}

const base = {
  id: 12,
  candidateId: 7,
  jobId: 3,
  status: ApplicationStatus.SCREENING,
  aiPaused: false,
};

describe('RecruitmentHandoffService.aiHandoff', () => {
  it('chuyển NEEDS_HR_REVIEW, khoá AI và lưu lý do/tóm tắt/độ ưu tiên', async () => {
    const { service, applicationRepo, handoffRepo, audit } = setup({ ...base });

    const result = await service.aiHandoff(12, {
      reason: HandoffReason.SALARY_OUT_OF_RANGE,
      summary: 'Ứng viên yêu cầu mức lương vượt range.',
      priority: HandoffPriority.HIGH,
    });

    expect(result).toMatchObject({
      handoffId: 61,
      reason: HandoffReason.SALARY_OUT_OF_RANGE,
      alreadyOpen: false,
      application: {
        id: 12,
        status: ApplicationStatus.NEEDS_HR_REVIEW,
        aiPaused: true,
      },
    });
    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ApplicationStatus.NEEDS_HR_REVIEW,
        aiPaused: true,
      }),
    );
    expect(handoffRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 12,
        reason: HandoffReason.SALARY_OUT_OF_RANGE,
        summary: 'Ứng viên yêu cầu mức lương vượt range.',
        priority: HandoffPriority.HIGH,
        status: HandoffStatus.OPEN,
        requestedByType: RecruitmentActorType.AI,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'HANDOFF_CREATE',
        before: expect.objectContaining({
          status: ApplicationStatus.SCREENING,
        }),
        after: expect.objectContaining({
          status: ApplicationStatus.NEEDS_HR_REVIEW,
        }),
      }),
    );
  });

  it('retry cùng lý do → trả yêu cầu đang mở, không tạo thêm', async () => {
    const { service, handoffRepo } = setup({
      ...base,
      status: ApplicationStatus.NEEDS_HR_REVIEW,
      aiPaused: true,
    });
    handoffRepo.findOne.mockResolvedValue({
      id: 61,
      reason: HandoffReason.COMPLAINT,
      priority: HandoffPriority.NORMAL,
      status: HandoffStatus.OPEN,
    });

    const result = await service.aiHandoff(12, {
      reason: HandoffReason.COMPLAINT,
      summary: 'Khiếu nại',
    });

    expect(result).toMatchObject({ handoffId: 61, alreadyOpen: true });
    expect(handoffRepo.save).not.toHaveBeenCalled();
  });

  it('từ OFFER: giữ trạng thái (AI không được kéo lùi) nhưng vẫn khoá AI', async () => {
    const { service, applicationRepo } = setup({
      ...base,
      status: ApplicationStatus.OFFER,
    });

    const result = await service.aiHandoff(12, {
      reason: HandoffReason.CANDIDATE_REQUESTED_HUMAN,
      summary: 'Muốn nói chuyện với HR',
    });

    expect(result.application).toEqual({
      id: 12,
      status: ApplicationStatus.OFFER,
      aiPaused: true,
    });
    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ApplicationStatus.OFFER,
        aiPaused: true,
      }),
    );
  });

  it('hồ sơ đã kết thúc → 409 APPLICATION_CLOSED', async () => {
    const { service } = setup({ ...base, status: ApplicationStatus.REJECTED });
    await expect(
      service.aiHandoff(12, { reason: HandoffReason.OTHER, summary: 'x' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'APPLICATION_CLOSED' }),
    });
  });

  it('DATA_DELETION_REQUEST: đánh dấu xoá, dừng AI với ứng viên, yêu cầu HR ưu tiên cao', async () => {
    const { service, candidateRepo, handoffRepo, applicationRepo } = setup({
      ...base,
    });

    const result = await service.aiHandoff(12, {
      reason: HandoffReason.DATA_DELETION_REQUEST,
      summary: 'Ứng viên muốn xoá toàn bộ thông tin',
    });

    expect(candidateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionRequestedAt: expect.any(Date),
        aiStoppedAt: expect.any(Date),
      }),
    );
    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ApplicationStatus.NEEDS_HR_REVIEW,
        aiPaused: true,
      }),
    );
    expect(handoffRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: HandoffReason.DATA_DELETION_REQUEST,
        priority: HandoffPriority.HIGH,
        applicationId: 12,
      }),
    );
    expect(result).toMatchObject({
      handoffId: 61,
      candidateAiStopped: true,
      alreadyOpen: false,
    });
  });
});
