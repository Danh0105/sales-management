import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import {
  AiMatchLevel,
  ApplicationStatus,
  HandoffReason,
  RecommendedAction,
  RecruitmentActorType,
} from '../recruitment.enums';
import { RecruitmentScreeningService } from './recruitment-screening.service';

const job = {
  id: 3,
  salaryMin: 8_000_000,
  salaryMax: 15_000_000,
  screeningCriteria: {
    minimumExperienceMonths: 12,
    requiredSkills: ['sales'],
    preferredSkills: ['CRM'],
    locations: ['Cà Mau'],
  },
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    fullName: 'Nguyễn Văn A',
    phone: '0901234567',
    totalExperienceMonths: null,
    skills: [],
    location: 'Cà Mau',
    expectedSalary: null,
    availableFrom: null,
    aiStoppedAt: null,
    ...overrides,
  };
}

function setup(app: Record<string, unknown>) {
  const applicationRepo = {
    findOne: jest.fn().mockResolvedValue(app),
    save: jest.fn(async (v) => v),
  } as any;
  const candidateRepo = { save: jest.fn(async (v) => v) } as any;
  const handoffRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: 88, ...v })),
  } as any;
  const interviewRepo = { findOne: jest.fn().mockResolvedValue(null) } as any;
  const repos = new Map<unknown, any>([
    [RecruitmentApplication, applicationRepo],
    [RecruitmentCandidate, candidateRepo],
    [RecruitmentHandoff, handoffRepo],
  ]);
  const em: any = { getRepository: (e: unknown) => repos.get(e) };
  handoffRepo.manager = em;
  const dataSource = { transaction: jest.fn(async (cb) => cb(em)) } as any;
  const audit = { record: jest.fn() } as any;

  const service = new RecruitmentScreeningService(
    applicationRepo,
    interviewRepo,
    dataSource,
    audit,
  );
  return {
    service,
    applicationRepo,
    candidateRepo,
    handoffRepo,
    interviewRepo,
    audit,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    candidateId: 7,
    jobId: 3,
    status: ApplicationStatus.COLLECTING_INFO,
    aiPaused: false,
    candidate: candidate(),
    job,
    ...overrides,
  };
}

describe('RecruitmentScreeningService', () => {
  it('HIGH_MATCH → QUALIFIED, lưu dữ liệu AI thu thập + breakdown, không mở handoff', async () => {
    const { service, applicationRepo, candidateRepo, handoffRepo, audit } =
      setup(application());

    const result = await service.screen(12, {
      extractedSkills: ['sales', 'CRM'],
      totalExperienceMonths: 24,
      expectedSalary: 12_000_000,
      aiSummary: '2 năm sales B2B',
    });

    expect(result).toMatchObject({
      applicationId: 12,
      score: 100,
      matchLevel: AiMatchLevel.HIGH_MATCH,
      recommendedAction: RecommendedAction.PROPOSE_INTERVIEW,
      status: ApplicationStatus.QUALIFIED,
      aiPaused: false,
      handoffId: null,
    });
    expect(candidateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        skills: ['sales', 'CRM'],
        totalExperienceMonths: 24,
      }),
    );
    expect(applicationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ApplicationStatus.QUALIFIED,
        aiMatchScore: 100,
        aiSummary: '2 năm sales B2B',
        aiScoreBreakdown: expect.objectContaining({ engineVersion: 'v1' }),
      }),
    );
    expect(handoffRepo.save).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'APPLICATION_SCREEN' }),
    );
  });

  it('MEDIUM_MATCH → NEEDS_HR_REVIEW, khoá AI, tự mở yêu cầu HR', async () => {
    const { service, handoffRepo } = setup(application());

    // kinh nghiệm 30×0.25 + kỹ năng 30 + ưu tiên 0 + địa điểm 15 + lương 15 = 67.5/95 → 71
    const result = await service.screen(12, {
      extractedSkills: ['sales'],
      totalExperienceMonths: 3,
      expectedSalary: 12_000_000,
    });

    expect(result).toMatchObject({
      score: 71,
      matchLevel: AiMatchLevel.MEDIUM_MATCH,
      status: ApplicationStatus.NEEDS_HR_REVIEW,
      aiPaused: true,
      handoffId: 88,
    });
    expect(handoffRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: HandoffReason.FINAL_DECISION_REQUIRED,
        requestedByType: RecruitmentActorType.SYSTEM,
      }),
    );
  });

  it('lương vượt khung → handoff SALARY_OUT_OF_RANGE', async () => {
    const { service, handoffRepo } = setup(application());

    const result = await service.screen(12, {
      extractedSkills: ['sales', 'CRM'],
      totalExperienceMonths: 24,
      expectedSalary: 25_000_000,
    });

    expect(result.recommendedAction).toBe(RecommendedAction.HANDOFF_TO_HR);
    expect(handoffRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ reason: HandoffReason.SALARY_OUT_OF_RANGE }),
    );
  });

  it('INSUFFICIENT_DATA → COLLECTING_INFO để AI hỏi tiếp, không khoá AI', async () => {
    const { service, handoffRepo } = setup(application());

    const result = await service.screen(12, {});

    expect(result).toMatchObject({
      matchLevel: AiMatchLevel.INSUFFICIENT_DATA,
      recommendedAction: RecommendedAction.COLLECT_MORE_INFO,
      status: ApplicationStatus.COLLECTING_INFO,
      aiPaused: false,
    });
    expect(result.missingInformation).toEqual(
      expect.arrayContaining([
        'totalExperienceMonths',
        'skills',
        'expectedSalary',
      ]),
    );
    expect(handoffRepo.save).not.toHaveBeenCalled();
  });

  it('hồ sơ đã chuyển HR → AI không chấm được (AI_PAUSED_FOR_HR)', async () => {
    const { service, applicationRepo } = setup(
      application({
        status: ApplicationStatus.NEEDS_HR_REVIEW,
        aiPaused: true,
      }),
    );

    await expect(service.screen(12, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_PAUSED_FOR_HR' }),
    });
    expect(applicationRepo.save).not.toHaveBeenCalled();
  });

  it('hồ sơ đã có lịch phỏng vấn → không chấm lại', async () => {
    const { service, interviewRepo } = setup(
      application({ status: ApplicationStatus.QUALIFIED }),
    );
    interviewRepo.findOne.mockResolvedValue({ id: 5 });

    await expect(service.screen(12, {})).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INTERVIEW_IN_PROGRESS' }),
    });
  });
});
