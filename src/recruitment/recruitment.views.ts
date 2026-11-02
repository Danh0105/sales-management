import { ConflictException } from '@nestjs/common';

import type { RecruitmentApplication } from './entities/recruitment-application.entity';
import type { RecruitmentCandidate } from './entities/recruitment-candidate.entity';
import type { RecruitmentInterview } from './entities/recruitment-interview.entity';
import type { RecruitmentJob } from './entities/recruitment-job.entity';
import { TERMINAL_APPLICATION_STATUSES } from './recruitment.enums';

/**
 * Dữ liệu trả cho OpenClaw — chỉ những gì AI cần để nói chuyện với ứng viên.
 * Không bao giờ có: ghi chú nội bộ của HR, lý do loại, người duyệt, id các hồ
 * sơ nghi trùng.
 */
export function toAiCandidateView(c: RecruitmentCandidate) {
  return {
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    email: c.email,
    zaloUserId: c.zaloUserId,
    source: c.source,
    location: c.location,
    education: c.education,
    experienceSummary: c.experienceSummary,
    totalExperienceMonths: c.totalExperienceMonths,
    currentJob: c.currentJob,
    expectedSalary: c.expectedSalary,
    availableFrom: c.availableFrom,
    skills: c.skills ?? [],
    cvUrl: c.cvUrl,
    metadata: c.metadata ?? {},
    suspectedDuplicate: (c.suspectedDuplicateIds ?? []).length > 0,
    deletionRequested: !!c.deletionRequestedAt,
    aiStopped: !!c.aiStoppedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function toAiJobView(j: RecruitmentJob) {
  return {
    id: j.id,
    code: j.code,
    title: j.title,
    description: j.description,
    department: j.department
      ? { id: j.department.id, name: j.department.name }
      : null,
    location: j.location,
    employmentType: j.employmentType,
    numberOfPositions: j.numberOfPositions,
    salaryMin: j.salaryMin,
    salaryMax: j.salaryMax,
    currency: j.currency,
    requirements: j.requirements,
    responsibilities: j.responsibilities,
    screeningCriteria: j.screeningCriteria ?? {},
    status: j.status,
    publishedAt: j.publishedAt,
  };
}

export function toAiApplicationView(a: RecruitmentApplication) {
  return {
    id: a.id,
    candidateId: a.candidateId,
    jobId: a.jobId,
    status: a.status,
    source: a.source,
    aiMatchScore: a.aiMatchScore,
    aiMatchLevel: a.aiMatchLevel,
    aiSummary: a.aiSummary,
    aiStrengths: a.aiStrengths ?? [],
    aiConcerns: a.aiConcerns ?? [],
    aiMissingInformation: a.aiMissingInformation ?? [],
    aiScoreBreakdown: a.aiScoreBreakdown,
    screeningCompletedAt: a.screeningCompletedAt,
    aiPaused: a.aiPaused,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export function toAiInterviewView(i: RecruitmentInterview) {
  return {
    id: i.id,
    applicationId: i.applicationId,
    candidateId: i.candidateId,
    jobId: i.jobId,
    slotId: i.slotId,
    scheduledStart: i.scheduledStart,
    scheduledEnd: i.scheduledEnd,
    timezone: i.timezone,
    location: i.location,
    meetingUrl: i.meetingUrl,
    status: i.status,
    candidateConfirmedAt: i.candidateConfirmedAt,
    createdByType: i.createdByType,
  };
}

/**
 * Chặn mọi thao tác **ghi/quyết định** của AI khi:
 * - ứng viên đã xin xoá dữ liệu (AI dừng hẳn với người này),
 * - hồ sơ đã chuyển HR và chưa được trả lại,
 * - hồ sơ đã kết thúc.
 * Lưu tin nhắn và đọc context không đi qua hàm này.
 */
export function assertAiCanAct(
  application: Pick<RecruitmentApplication, 'aiPaused' | 'status'> | null,
  candidate: Pick<RecruitmentCandidate, 'aiStoppedAt'> | null,
): void {
  if (candidate?.aiStoppedAt) {
    throw new ConflictException({
      code: 'AI_STOPPED_FOR_CANDIDATE',
      message:
        'Ứng viên đã yêu cầu xoá dữ liệu — AI dừng xử lý, HR sẽ liên hệ trực tiếp',
    });
  }
  if (!application) return;
  if (TERMINAL_APPLICATION_STATUSES.includes(application.status)) {
    throw new ConflictException({
      code: 'APPLICATION_CLOSED',
      message: `Hồ sơ đã kết thúc (${application.status})`,
    });
  }
  if (application.aiPaused) {
    throw new ConflictException({
      code: 'AI_PAUSED_FOR_HR',
      message:
        'Hồ sơ đã chuyển HR — AI chỉ được lưu tin nhắn và đọc context, không đưa ra quyết định',
    });
  }
}

/** Lỗi unique của Postgres (23505). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { code?: unknown }).code === '23505' ||
      (error as { driverError?: { code?: unknown } }).driverError?.code ===
        '23505')
  );
}

/** Ranh giới ngày theo giờ Việt Nam cho lọc `fromDate/toDate`. */
export function vnDayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000+07:00`);
}

export function vnDayEnd(date: string): Date {
  return new Date(`${date}T23:59:59.999+07:00`);
}

/** `%`/`_` trong từ khoá là ký tự thường, không phải wildcard. */
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}
