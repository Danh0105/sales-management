import { AiMatchLevel, RecommendedAction } from '../recruitment.enums';
import {
  evaluateScreening,
  requiredCandidateFields,
  SCREENING_ENGINE_VERSION,
} from './screening-engine';
import type {
  ScreeningCandidateInput,
  ScreeningJobInput,
} from './screening.types';

const TODAY = '2026-10-05';

const salesJob: ScreeningJobInput = {
  salaryMin: 8_000_000,
  salaryMax: 15_000_000,
  criteria: {
    minimumExperienceMonths: 12,
    requiredSkills: ['sales'],
    preferredSkills: ['CRM'],
    locations: ['Cà Mau'],
    availableImmediatelyPreferred: true,
  },
};

const strongCandidate: ScreeningCandidateInput = {
  totalExperienceMonths: 24,
  skills: ['Sales', 'crm'],
  location: 'TP. Cà Mau',
  expectedSalary: 12_000_000,
  availableFrom: '2026-10-08',
};

describe('evaluateScreening', () => {
  it('HIGH_MATCH: đủ mọi tiêu chí → 100 điểm, đề xuất phỏng vấn', () => {
    const r = evaluateScreening(salesJob, strongCandidate, TODAY);

    expect(r.score).toBe(100);
    expect(r.matchLevel).toBe(AiMatchLevel.HIGH_MATCH);
    expect(r.recommendedAction).toBe(RecommendedAction.PROPOSE_INTERVIEW);
    expect(r.missingInformation).toEqual([]);
    expect(r.concerns).toEqual([]);
    expect(r.strengths).toEqual(
      expect.arrayContaining([
        'Đủ kinh nghiệm: 24/12 tháng kinh nghiệm',
        'Có đủ kỹ năng bắt buộc: sales',
      ]),
    );
    expect(r.breakdown.engineVersion).toBe(SCREENING_ENGINE_VERSION);
    expect(r.breakdown.applicableWeight).toBe(100);
  });

  it('tất định: cùng đầu vào + cùng ngày luôn ra cùng kết quả', () => {
    const a = evaluateScreening(salesJob, strongCandidate, TODAY);
    const b = evaluateScreening(salesJob, { ...strongCandidate }, TODAY);
    expect(b).toEqual(a);
  });

  it('MEDIUM_MATCH: kinh nghiệm thiếu và ở ngoài khu vực → 50..74, HR xem xét', () => {
    const r = evaluateScreening(
      salesJob,
      { ...strongCandidate, totalExperienceMonths: 6, location: 'Bạc Liêu' },
      TODAY,
    );

    // kinh nghiệm 30×0.5 + kỹ năng 30 + ưu tiên 5 + lương 15 + bắt đầu 5 = 70
    expect(r.score).toBe(70);
    expect(r.matchLevel).toBe(AiMatchLevel.MEDIUM_MATCH);
    expect(r.recommendedAction).toBe(RecommendedAction.HR_REVIEW);
    expect(r.concerns).toEqual(
      expect.arrayContaining([
        'Kinh nghiệm chưa đạt yêu cầu: 6/12 tháng kinh nghiệm',
        'Địa điểm "Bạc Liêu" ngoài khu vực tuyển (Cà Mau)',
      ]),
    );
  });

  it('LOW_MATCH: không có kỹ năng bắt buộc, ít kinh nghiệm → < 50, không tự loại mà chuyển HR', () => {
    const r = evaluateScreening(
      salesJob,
      {
        totalExperienceMonths: 2,
        skills: ['kế toán'],
        location: 'Hà Nội',
        expectedSalary: 9_000_000,
        availableFrom: '2026-12-30',
      },
      TODAY,
    );

    expect(r.score).toBeLessThan(50);
    expect(r.matchLevel).toBe(AiMatchLevel.LOW_MATCH);
    expect(r.recommendedAction).toBe(RecommendedAction.HR_REVIEW);
    expect(r.concerns).toContain('Thiếu kỹ năng bắt buộc: sales');
  });

  it('INSUFFICIENT_DATA: thiếu dữ liệu ở ≥ 40% trọng số → hỏi thêm', () => {
    const r = evaluateScreening(
      salesJob,
      {
        totalExperienceMonths: null,
        skills: [],
        location: 'Cà Mau',
        expectedSalary: null,
        availableFrom: null,
      },
      TODAY,
    );

    expect(r.matchLevel).toBe(AiMatchLevel.INSUFFICIENT_DATA);
    expect(r.recommendedAction).toBe(RecommendedAction.COLLECT_MORE_INFO);
    expect(r.missingInformation).toEqual([
      'totalExperienceMonths',
      'skills',
      'expectedSalary',
      'availableFrom',
    ]);
    expect(r.breakdown.missingWeight).toBe(85);
  });

  it('vị trí chưa khai tiêu chí → INSUFFICIENT_DATA và chuyển HR thay vì đoán', () => {
    const r = evaluateScreening(
      { salaryMin: null, salaryMax: null, criteria: {} },
      strongCandidate,
      TODAY,
    );
    expect(r.matchLevel).toBe(AiMatchLevel.INSUFFICIENT_DATA);
    expect(r.recommendedAction).toBe(RecommendedAction.HR_REVIEW);
    expect(r.score).toBe(0);
  });

  it('lương vượt trần > 10% → luôn chuyển HR (SALARY_OUT_OF_RANGE)', () => {
    const r = evaluateScreening(
      salesJob,
      { ...strongCandidate, expectedSalary: 20_000_000 },
      TODAY,
    );
    expect(r.salaryOutOfRange).toBe(true);
    expect(r.recommendedAction).toBe(RecommendedAction.HANDOFF_TO_HR);
    expect(r.score).toBe(85);
  });

  it('lương vượt trần ≤ 10% → nửa điểm, không bắt buộc chuyển HR', () => {
    const r = evaluateScreening(
      salesJob,
      { ...strongCandidate, expectedSalary: 16_000_000 },
      TODAY,
    );
    expect(r.salaryOutOfRange).toBe(false);
    expect(r.score).toBe(93);
    expect(r.matchLevel).toBe(AiMatchLevel.HIGH_MATCH);
  });

  it('thiếu kỹ năng bắt buộc thì tối đa MEDIUM dù điểm cao', () => {
    const job: ScreeningJobInput = {
      salaryMin: null,
      salaryMax: 15_000_000,
      criteria: {
        minimumExperienceMonths: 12,
        requiredSkills: ['sales', 'crm', 'excel', 'tiếng anh', 'lái xe'],
        locations: ['Cà Mau'],
      },
    };
    const r = evaluateScreening(
      job,
      { ...strongCandidate, skills: ['sales', 'crm', 'excel', 'tiếng anh'] },
      TODAY,
    );
    // 30 + 30×0.8 + 15 + 15 = 84/90 → 93 điểm nhưng thiếu "lái xe"
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.matchLevel).toBe(AiMatchLevel.MEDIUM_MATCH);
    expect(r.breakdown.adjustments).toContain(
      'Thiếu kỹ năng bắt buộc nên tối đa MEDIUM_MATCH',
    );
  });

  it('so khớp kỹ năng và địa điểm không phân biệt hoa thường / dấu tiếng Việt', () => {
    const job: ScreeningJobInput = {
      salaryMin: null,
      salaryMax: null,
      criteria: {
        requiredSkills: ['Bán hàng B2B'],
        locations: ['Thành phố Hồ Chí Minh'],
      },
    };
    const r = evaluateScreening(
      job,
      {
        ...strongCandidate,
        skills: ['ban hang b2b'],
        location: 'Quận 1, Hồ Chí Minh',
      },
      TODAY,
    );
    expect(r.score).toBe(100);
  });

  it('chỉ đọc tiêu chí công việc — khoá lạ trong criteria không ảnh hưởng điểm', () => {
    const withJunk = {
      ...salesJob,
      criteria: { ...salesJob.criteria, gender: 'male', maxAge: 30 } as never,
    };
    expect(evaluateScreening(withJunk, strongCandidate, TODAY)).toEqual(
      evaluateScreening(salesJob, strongCandidate, TODAY),
    );
  });
});

describe('requiredCandidateFields', () => {
  it('liệt kê field ứng viên mà tiêu chí của vị trí cần', () => {
    expect(requiredCandidateFields(salesJob)).toEqual([
      'fullName',
      'phone',
      'totalExperienceMonths',
      'skills',
      'location',
      'expectedSalary',
      'availableFrom',
    ]);
    expect(
      requiredCandidateFields({
        salaryMin: null,
        salaryMax: null,
        criteria: {},
      }),
    ).toEqual(['fullName', 'phone']);
  });
});
