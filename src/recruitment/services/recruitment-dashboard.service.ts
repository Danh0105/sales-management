import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';

import type { DashboardQueryDto } from '../dto/handoff.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentHandoff } from '../entities/recruitment-handoff.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import {
  ApplicationStatus,
  HandoffStatus,
  InterviewStatus,
  RecruitmentJobStatus,
} from '../recruitment.enums';
import { vnDayEnd, vnDayStart } from '../recruitment.views';

@Injectable()
export class RecruitmentDashboardService {
  constructor(
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentHandoff)
    private readonly handoffRepo: Repository<RecruitmentHandoff>,
    @InjectRepository(RecruitmentInterview)
    private readonly interviewRepo: Repository<RecruitmentInterview>,
    @InjectRepository(RecruitmentJob)
    private readonly jobRepo: Repository<RecruitmentJob>,
  ) {}

  /**
   * Số hồ sơ theo giai đoạn. `newCandidates` = hồ sơ mới và đang thu thập
   * thông tin (AI chưa chấm). Lọc `jobId`/`fromDate`/`toDate` áp lên hồ sơ;
   * `openHandoffs`, `upcomingInterviews`, `activeJobs` là số hiện tại.
   */
  async summary(query: DashboardQueryDto) {
    const qb = this.applicationRepo
      .createQueryBuilder('a')
      .select('a.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('a.status');
    if (query.jobId) qb.andWhere('a.jobId = :jobId', { jobId: query.jobId });
    if (query.fromDate)
      qb.andWhere('a.createdAt >= :from', { from: vnDayStart(query.fromDate) });
    if (query.toDate)
      qb.andWhere('a.createdAt <= :to', { to: vnDayEnd(query.toDate) });

    const rows = await qb.getRawMany<{
      status: ApplicationStatus;
      count: string;
    }>();
    const byStatus = Object.fromEntries(
      Object.values(ApplicationStatus).map((s) => [s, 0]),
    ) as Record<ApplicationStatus, number>;
    for (const row of rows) byStatus[row.status] = Number(row.count);

    const jobFilter = query.jobId ? { jobId: query.jobId } : {};
    const [openHandoffs, upcomingInterviews, activeJobs] = await Promise.all([
      this.handoffRepo.count({ where: { status: HandoffStatus.OPEN } }),
      this.interviewRepo.count({
        where: {
          ...jobFilter,
          status: In([InterviewStatus.PROPOSED, InterviewStatus.CONFIRMED]),
          scheduledStart: MoreThanOrEqual(new Date()),
        },
      }),
      this.jobRepo.count({ where: { status: RecruitmentJobStatus.ACTIVE } }),
    ]);

    return {
      newCandidates: byStatus.NEW + byStatus.COLLECTING_INFO,
      screening: byStatus.SCREENING,
      qualified: byStatus.QUALIFIED,
      interviews: byStatus.INTERVIEW,
      offers: byStatus.OFFER,
      hired: byStatus.HIRED,
      needsHrReview: byStatus.NEEDS_HR_REVIEW,
      rejected: byStatus.REJECTED,
      withdrawn: byStatus.WITHDRAWN,
      totalApplications: Object.values(byStatus).reduce((s, n) => s + n, 0),
      openHandoffs,
      upcomingInterviews,
      activeJobs,
      byStatus,
    };
  }
}
