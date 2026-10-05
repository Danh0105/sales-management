import type { AiMatchLevel, RecommendedAction } from '../recruitment.enums';

/**
 * Tiêu chí sàng lọc của một vị trí. Chỉ gồm tiêu chí liên quan trực tiếp tới
 * công việc — **không** có chỗ cho giới tính, tuổi, tôn giáo, dân tộc, hôn
 * nhân, sức khoẻ, ngoại hình, chính trị (DTO chặn mọi khoá lạ).
 */
export interface ScreeningCriteria {
  minimumExperienceMonths?: number;
  requiredSkills?: string[];
  preferredSkills?: string[];
  locations?: string[];
  /** Ưu tiên người đi làm được ngay (trong 7 ngày). */
  availableImmediatelyPreferred?: boolean;
  /** Số ngày tối đa từ hôm sàng lọc tới ngày bắt đầu làm. */
  maxStartDelayDays?: number;
}

export type ScreeningCriterionKey =
  | 'experience'
  | 'requiredSkills'
  | 'preferredSkills'
  | 'location'
  | 'salary'
  | 'availability';

/** Field của ứng viên mà một tiêu chí cần — trả về cho AI để biết còn phải hỏi gì. */
export type CandidateScreeningField =
  | 'totalExperienceMonths'
  | 'skills'
  | 'location'
  | 'expectedSalary'
  | 'availableFrom';

export interface ScreeningCriterionResult {
  criterion: ScreeningCriterionKey;
  weight: number;
  /** 0..1, `null` khi thiếu dữ liệu. */
  fraction: number | null;
  /** Điểm thực nhận = weight × fraction (0 khi thiếu dữ liệu). */
  earned: number;
  missingField: CandidateScreeningField | null;
  detail: string;
}

export interface ScreeningBreakdown {
  engineVersion: string;
  evaluatedOn: string;
  applicableWeight: number;
  earnedWeight: number;
  missingWeight: number;
  criteria: ScreeningCriterionResult[];
  /** Quy tắc đã chặn/điều chỉnh mức phù hợp, để giải thích vì sao. */
  adjustments: string[];
}

export interface ScreeningJobInput {
  salaryMin: number | null;
  salaryMax: number | null;
  criteria: ScreeningCriteria | null | undefined;
}

export interface ScreeningCandidateInput {
  totalExperienceMonths: number | null;
  skills: string[];
  location: string | null;
  expectedSalary: number | null;
  /** `YYYY-MM-DD`. */
  availableFrom: string | null;
}

export interface ScreeningResult {
  score: number;
  matchLevel: AiMatchLevel;
  strengths: string[];
  concerns: string[];
  missingInformation: CandidateScreeningField[];
  recommendedAction: RecommendedAction;
  /** Lương vượt trần quá ngưỡng — phải chuyển HR. */
  salaryOutOfRange: boolean;
  breakdown: ScreeningBreakdown;
}
