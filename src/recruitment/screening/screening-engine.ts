import { AiMatchLevel, RecommendedAction } from '../recruitment.enums';
import { normalizeText } from '../utils/text-normalize';
import type {
  CandidateScreeningField,
  ScreeningCandidateInput,
  ScreeningCriteria,
  ScreeningCriterionResult,
  ScreeningJobInput,
  ScreeningResult,
} from './screening.types';

/**
 * Bộ chấm điểm sàng lọc — **tất định**: cùng tiêu chí + cùng dữ liệu ứng viên
 * + cùng ngày thì luôn ra cùng điểm. LLM không chấm điểm; AI chỉ thu thập dữ
 * liệu, map kỹ năng về từ vựng của vị trí và viết tóm tắt (không ảnh hưởng điểm).
 *
 * Đổi trọng số/ngưỡng thì tăng `SCREENING_ENGINE_VERSION` để breakdown cũ vẫn
 * giải thích đúng theo phiên bản đã chấm.
 */
export const SCREENING_ENGINE_VERSION = 'v1';

/** Chỉ tính các tiêu chí vị trí có khai, rồi quy về thang 100. */
export const SCREENING_WEIGHTS = {
  experience: 30,
  requiredSkills: 30,
  location: 15,
  salary: 15,
  preferredSkills: 5,
  availability: 5,
} as const;

export const HIGH_MATCH_MIN_SCORE = 75;
export const MEDIUM_MATCH_MIN_SCORE = 50;
/** Thiếu dữ liệu ở ≥ 40% trọng số thì không đủ cơ sở xếp mức. */
export const INSUFFICIENT_MISSING_RATIO = 0.4;
/** Vượt trần lương ≤ 10% còn nửa điểm; quá nữa thì phải chuyển HR. */
export const SALARY_TOLERANCE_RATIO = 0.1;
/** "Đi làm ngay" = trong 7 ngày. */
export const IMMEDIATE_START_DAYS = 7;
/** Trễ hơn hạn bắt đầu tối đa 30 ngày thì còn nửa điểm. */
export const START_DELAY_GRACE_DAYS = 30;

const LOCATION_PREFIXES = /^(?:tp|thanh pho|tinh)\s+/;

function uniqueNormalized(values: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of values ?? []) {
    const key = normalizeText(raw);
    if (key && !map.has(key)) map.set(key, raw.trim());
  }
  return map;
}

function normalizeLocation(value: string): string {
  return normalizeText(value).replace(LOCATION_PREFIXES, '');
}

function locationMatches(candidate: string, allowed: string[]): boolean {
  const c = normalizeLocation(candidate);
  if (!c) return false;
  return allowed.some((raw) => {
    const a = normalizeLocation(raw);
    if (!a) return false;
    return c.includes(a) || (c.length >= 3 && a.includes(c));
  });
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('vi-VN').format(value);
}

function missing(
  criterion: ScreeningCriterionResult['criterion'],
  weight: number,
  field: CandidateScreeningField,
  detail: string,
): ScreeningCriterionResult {
  return {
    criterion,
    weight,
    fraction: null,
    earned: 0,
    missingField: field,
    detail,
  };
}

function scored(
  criterion: ScreeningCriterionResult['criterion'],
  weight: number,
  fraction: number,
  detail: string,
): ScreeningCriterionResult {
  const bounded = Math.max(0, Math.min(1, fraction));
  return {
    criterion,
    weight,
    fraction: Math.round(bounded * 1000) / 1000,
    earned: Math.round(weight * bounded * 100) / 100,
    missingField: null,
    detail,
  };
}

/**
 * @param today ngày sàng lọc `YYYY-MM-DD` (giờ Việt Nam) — truyền vào thay vì
 *              đọc đồng hồ để kết quả tái lập được.
 */
export function evaluateScreening(
  job: ScreeningJobInput,
  candidate: ScreeningCandidateInput,
  today: string,
): ScreeningResult {
  const criteria: ScreeningCriteria = job.criteria ?? {};
  const results: ScreeningCriterionResult[] = [];
  const strengths: string[] = [];
  const concerns: string[] = [];
  const adjustments: string[] = [];
  let salaryOutOfRange = false;

  const candidateSkills = new Set(
    (candidate.skills ?? []).map(normalizeText).filter(Boolean),
  );
  const hasSkills = candidateSkills.size > 0;

  // --- Kinh nghiệm ---------------------------------------------------------
  const minExp = criteria.minimumExperienceMonths ?? 0;
  if (minExp > 0) {
    const w = SCREENING_WEIGHTS.experience;
    const months = candidate.totalExperienceMonths;
    if (months === null || months === undefined) {
      results.push(
        missing(
          'experience',
          w,
          'totalExperienceMonths',
          'Chưa có số tháng kinh nghiệm',
        ),
      );
    } else {
      const detail = `${months}/${minExp} tháng kinh nghiệm`;
      results.push(scored('experience', w, months / minExp, detail));
      if (months >= minExp) strengths.push(`Đủ kinh nghiệm: ${detail}`);
      else concerns.push(`Kinh nghiệm chưa đạt yêu cầu: ${detail}`);
    }
  }

  // --- Kỹ năng bắt buộc ----------------------------------------------------
  const required = uniqueNormalized(criteria.requiredSkills);
  let missingRequiredSkills = false;
  if (required.size > 0) {
    const w = SCREENING_WEIGHTS.requiredSkills;
    if (!hasSkills) {
      results.push(
        missing('requiredSkills', w, 'skills', 'Chưa có danh sách kỹ năng'),
      );
    } else {
      const matched = [...required]
        .filter(([k]) => candidateSkills.has(k))
        .map(([, v]) => v);
      const lacking = [...required]
        .filter(([k]) => !candidateSkills.has(k))
        .map(([, v]) => v);
      results.push(
        scored(
          'requiredSkills',
          w,
          matched.length / required.size,
          `Khớp ${matched.length}/${required.size} kỹ năng bắt buộc`,
        ),
      );
      if (lacking.length === 0) {
        strengths.push(`Có đủ kỹ năng bắt buộc: ${matched.join(', ')}`);
      } else {
        missingRequiredSkills = true;
        if (matched.length) strengths.push(`Có kỹ năng: ${matched.join(', ')}`);
        concerns.push(`Thiếu kỹ năng bắt buộc: ${lacking.join(', ')}`);
      }
    }
  }

  // --- Kỹ năng ưu tiên -----------------------------------------------------
  const preferred = uniqueNormalized(criteria.preferredSkills);
  if (preferred.size > 0) {
    const w = SCREENING_WEIGHTS.preferredSkills;
    if (!hasSkills) {
      results.push(
        missing('preferredSkills', w, 'skills', 'Chưa có danh sách kỹ năng'),
      );
    } else {
      const matched = [...preferred]
        .filter(([k]) => candidateSkills.has(k))
        .map(([, v]) => v);
      results.push(
        scored(
          'preferredSkills',
          w,
          matched.length / preferred.size,
          `Khớp ${matched.length}/${preferred.size} kỹ năng ưu tiên`,
        ),
      );
      if (matched.length)
        strengths.push(`Có kỹ năng ưu tiên: ${matched.join(', ')}`);
    }
  }

  // --- Địa điểm ------------------------------------------------------------
  const locations = (criteria.locations ?? []).filter((l) => l && l.trim());
  if (locations.length > 0) {
    const w = SCREENING_WEIGHTS.location;
    const loc = candidate.location?.trim();
    if (!loc) {
      results.push(
        missing('location', w, 'location', 'Chưa có nơi ở/khu vực làm việc'),
      );
    } else if (locationMatches(loc, locations)) {
      results.push(scored('location', w, 1, `"${loc}" thuộc khu vực tuyển`));
      strengths.push(`Ở khu vực tuyển: ${loc}`);
    } else {
      results.push(scored('location', w, 0, `"${loc}" ngoài khu vực tuyển`));
      concerns.push(
        `Địa điểm "${loc}" ngoài khu vực tuyển (${locations.join(', ')})`,
      );
    }
  }

  // --- Lương ---------------------------------------------------------------
  if (job.salaryMin !== null || job.salaryMax !== null) {
    const w = SCREENING_WEIGHTS.salary;
    const expected = candidate.expectedSalary;
    if (expected === null || expected === undefined) {
      results.push(
        missing('salary', w, 'expectedSalary', 'Chưa có mức lương mong muốn'),
      );
    } else if (job.salaryMax !== null && expected > job.salaryMax) {
      const over =
        job.salaryMax > 0
          ? (expected - job.salaryMax) / job.salaryMax
          : Infinity;
      const pct = Number.isFinite(over) ? `${Math.round(over * 100)}%` : 'vượt';
      const detail = `Lương mong muốn ${formatMoney(expected)} vượt trần ${formatMoney(job.salaryMax)} (${pct})`;
      if (over <= SALARY_TOLERANCE_RATIO) {
        results.push(scored('salary', w, 0.5, detail));
        concerns.push(detail);
      } else {
        results.push(scored('salary', w, 0, detail));
        concerns.push(`${detail} — cần HR quyết định`);
        salaryOutOfRange = true;
      }
    } else {
      results.push(
        scored(
          'salary',
          w,
          1,
          `Lương mong muốn ${formatMoney(expected)} nằm trong khung`,
        ),
      );
      strengths.push(
        `Lương mong muốn ${formatMoney(expected)} nằm trong khung`,
      );
    }
  }

  // --- Thời gian bắt đầu ---------------------------------------------------
  if (
    criteria.availableImmediatelyPreferred === true ||
    (criteria.maxStartDelayDays !== undefined &&
      criteria.maxStartDelayDays !== null)
  ) {
    const w = SCREENING_WEIGHTS.availability;
    if (!candidate.availableFrom) {
      results.push(
        missing(
          'availability',
          w,
          'availableFrom',
          'Chưa có ngày có thể bắt đầu',
        ),
      );
    } else {
      const limit = criteria.maxStartDelayDays ?? IMMEDIATE_START_DAYS;
      const delay = Math.max(0, daysBetween(today, candidate.availableFrom));
      const detail =
        delay === 0
          ? 'Có thể bắt đầu ngay'
          : `Có thể bắt đầu sau ${delay} ngày`;
      if (delay <= limit) {
        results.push(scored('availability', w, 1, detail));
        strengths.push(detail);
      } else if (delay <= limit + START_DELAY_GRACE_DAYS) {
        results.push(
          scored(
            'availability',
            w,
            0.5,
            `${detail} (mong muốn ≤ ${limit} ngày)`,
          ),
        );
        concerns.push(`${detail}, trễ hơn mong muốn ${limit} ngày`);
      } else {
        results.push(
          scored('availability', w, 0, `${detail} (mong muốn ≤ ${limit} ngày)`),
        );
        concerns.push(
          `${detail}, trễ hơn nhiều so với mong muốn ${limit} ngày`,
        );
      }
    }
  }

  // --- Tổng hợp ------------------------------------------------------------
  const applicableWeight = results.reduce((s, r) => s + r.weight, 0);
  const earnedWeight =
    Math.round(results.reduce((s, r) => s + r.earned, 0) * 100) / 100;
  const missingWeight = results
    .filter((r) => r.fraction === null)
    .reduce((s, r) => s + r.weight, 0);
  const missingInformation = [
    ...new Set(
      results
        .map((r) => r.missingField)
        .filter((f): f is CandidateScreeningField => !!f),
    ),
  ];

  let score = 0;
  let matchLevel: AiMatchLevel;

  if (applicableWeight === 0) {
    matchLevel = AiMatchLevel.INSUFFICIENT_DATA;
    const note = 'Vị trí chưa khai tiêu chí sàng lọc nào — cần HR đánh giá';
    adjustments.push(note);
    concerns.push(note);
  } else {
    score = Math.round((earnedWeight / applicableWeight) * 100);
    if (missingWeight / applicableWeight >= INSUFFICIENT_MISSING_RATIO) {
      matchLevel = AiMatchLevel.INSUFFICIENT_DATA;
      adjustments.push(
        `Thiếu dữ liệu ở ${missingWeight}/${applicableWeight} trọng số (≥ ${INSUFFICIENT_MISSING_RATIO * 100}%)`,
      );
    } else if (score >= HIGH_MATCH_MIN_SCORE) {
      matchLevel = AiMatchLevel.HIGH_MATCH;
    } else if (score >= MEDIUM_MATCH_MIN_SCORE) {
      matchLevel = AiMatchLevel.MEDIUM_MATCH;
    } else {
      matchLevel = AiMatchLevel.LOW_MATCH;
    }

    if (matchLevel === AiMatchLevel.HIGH_MATCH && missingRequiredSkills) {
      matchLevel = AiMatchLevel.MEDIUM_MATCH;
      adjustments.push('Thiếu kỹ năng bắt buộc nên tối đa MEDIUM_MATCH');
    }
  }

  let recommendedAction: RecommendedAction;
  if (salaryOutOfRange) {
    recommendedAction = RecommendedAction.HANDOFF_TO_HR;
  } else if (matchLevel === AiMatchLevel.INSUFFICIENT_DATA) {
    recommendedAction =
      applicableWeight === 0
        ? RecommendedAction.HR_REVIEW
        : RecommendedAction.COLLECT_MORE_INFO;
  } else if (matchLevel === AiMatchLevel.HIGH_MATCH) {
    recommendedAction = RecommendedAction.PROPOSE_INTERVIEW;
  } else if (missingInformation.length > 0) {
    // Điểm thấp có thể chỉ vì chưa hỏi đủ — hỏi nốt rồi chấm lại trước khi đẩy cho HR.
    recommendedAction = RecommendedAction.COLLECT_MORE_INFO;
  } else {
    recommendedAction = RecommendedAction.HR_REVIEW;
  }

  return {
    score,
    matchLevel,
    strengths,
    concerns,
    missingInformation,
    recommendedAction,
    salaryOutOfRange,
    breakdown: {
      engineVersion: SCREENING_ENGINE_VERSION,
      evaluatedOn: today,
      applicableWeight,
      earnedWeight,
      missingWeight,
      criteria: results,
      adjustments,
    },
  };
}

/**
 * Field ứng viên mà vị trí cần để sàng lọc, cộng thông tin liên lạc tối
 * thiểu. Dùng cho `missingFields` trong context trả về AI.
 */
export function requiredCandidateFields(
  job: ScreeningJobInput,
): Array<CandidateScreeningField | 'fullName' | 'phone'> {
  const c = job.criteria ?? {};
  const fields: Array<CandidateScreeningField | 'fullName' | 'phone'> = [
    'fullName',
    'phone',
  ];
  if ((c.minimumExperienceMonths ?? 0) > 0)
    fields.push('totalExperienceMonths');
  if (
    (c.requiredSkills?.length ?? 0) > 0 ||
    (c.preferredSkills?.length ?? 0) > 0
  )
    fields.push('skills');
  if ((c.locations?.length ?? 0) > 0) fields.push('location');
  if (job.salaryMin !== null || job.salaryMax !== null)
    fields.push('expectedSalary');
  if (
    c.availableImmediatelyPreferred === true ||
    (c.maxStartDelayDays !== undefined && c.maxStartDelayDays !== null)
  )
    fields.push('availableFrom');
  return fields;
}
