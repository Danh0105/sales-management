import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import {
  assertApplicationTransition,
  canTransition,
} from '../application-status.state-machine';
import type {
  AiInterviewSlotsQueryDto,
  AiProposeInterviewDto,
} from '../dto/ai.dto';
import type { Paginated } from '../dto/common.dto';
import type {
  CreateInterviewDto,
  CreateInterviewSlotDto,
  QueryInterviewDto,
  QueryInterviewSlotDto,
  UpdateInterviewDto,
  UpdateInterviewSlotDto,
} from '../dto/interview.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentInterviewSlot } from '../entities/recruitment-interview-slot.entity';
import { RecruitmentInterview } from '../entities/recruitment-interview.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentAuditService } from '../recruitment-audit.service';
import {
  ApplicationStatus,
  InterviewStatus,
  RecruitmentActorType,
  RecruitmentJobStatus,
} from '../recruitment.enums';
import { AI_ACTOR, type RecruitmentActor } from '../recruitment.roles';
import {
  assertAiCanAct,
  isUniqueViolation,
  toAiInterviewView,
} from '../recruitment.views';
import {
  AI_SLOT_DEFAULT_WINDOW_DAYS,
  AI_SLOT_MIN_LEAD_MINUTES,
  INTERVIEW_SLOT_PROVIDER,
  type InterviewSlotProvider,
} from './interview-slot.provider';

const { PROPOSED, CONFIRMED, COMPLETED, CANCELLED, NO_SHOW } = InterviewStatus;
const ACTIVE_STATUSES = [PROPOSED, CONFIRMED];

/** Luồng lịch phỏng vấn: PROPOSED → CONFIRMED → COMPLETED/NO_SHOW; huỷ được khi chưa diễn ra. */
const INTERVIEW_TRANSITIONS: Record<InterviewStatus, InterviewStatus[]> = {
  [PROPOSED]: [CONFIRMED, CANCELLED],
  [CONFIRMED]: [COMPLETED, CANCELLED, NO_SHOW],
  [COMPLETED]: [],
  [CANCELLED]: [],
  [NO_SHOW]: [],
};

/** Hồ sơ ở các trạng thái này HR mới hẹn phỏng vấn được. */
const HR_SCHEDULABLE = [
  ApplicationStatus.QUALIFIED,
  ApplicationStatus.NEEDS_HR_REVIEW,
  ApplicationStatus.INTERVIEW,
];

@Injectable()
export class RecruitmentInterviewService {
  constructor(
    @InjectRepository(RecruitmentInterview)
    private readonly interviewRepo: Repository<RecruitmentInterview>,
    @InjectRepository(RecruitmentInterviewSlot)
    private readonly slotRepo: Repository<RecruitmentInterviewSlot>,
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentJob)
    private readonly jobRepo: Repository<RecruitmentJob>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(INTERVIEW_SLOT_PROVIDER)
    private readonly slots: InterviewSlotProvider,
    private readonly audit: RecruitmentAuditService,
  ) {}

  // ------------------------------------------------------- slots (HR) ----

  async createSlot(dto: CreateInterviewSlotDto, actor: RecruitmentActor) {
    const { start, end } = this.parseRange(dto.startAt, dto.endAt);
    if (start <= new Date()) {
      throw new BadRequestException({
        code: 'SLOT_IN_PAST',
        message: 'Slot phỏng vấn phải ở tương lai',
      });
    }
    if (dto.jobId) await this.getJobOrThrow(dto.jobId);
    await this.assertEmployee(dto.interviewerId);

    const slot = await this.slotRepo.save(
      this.slotRepo.create({
        jobId: dto.jobId ?? null,
        interviewerId: dto.interviewerId ?? null,
        startAt: start,
        endAt: end,
        timezone: dto.timezone ?? 'Asia/Ho_Chi_Minh',
        location: dto.location ?? null,
        meetingUrl: dto.meetingUrl ?? null,
        capacity: dto.capacity ?? 1,
        bookedCount: 0,
        isActive: true,
        notes: dto.notes ?? null,
        createdBy: actor.employeeId,
      }),
    );
    await this.audit.record({
      actor,
      action: 'INTERVIEW_SLOT_CREATE',
      entity: 'interview-slots',
      entityId: slot.id,
      after: slot,
    });
    return slot;
  }

  /**
   * Đã có người đặt thì không đổi giờ (lịch đã hẹn chốt giờ lúc đặt) và không
   * giảm sức chứa xuống dưới số đã đặt. Đóng slot (`isActive=false`) chỉ chặn
   * đặt thêm, không huỷ lịch đã có.
   */
  async updateSlot(
    id: number,
    dto: UpdateInterviewSlotDto,
    actor: RecruitmentActor,
  ) {
    const slot = await this.slotRepo.findOne({ where: { id } });
    if (!slot) {
      throw new NotFoundException({
        code: 'SLOT_NOT_FOUND',
        message: `Không tìm thấy slot #${id}`,
      });
    }
    const before = { ...slot };

    const timeChanged = dto.startAt !== undefined || dto.endAt !== undefined;
    if (timeChanged) {
      if (slot.bookedCount > 0) {
        throw new ConflictException({
          code: 'SLOT_HAS_BOOKINGS',
          message: 'Slot đã có lịch đặt — không đổi giờ được, hãy tạo slot mới',
        });
      }
      const { start, end } = this.parseRange(
        dto.startAt ?? slot.startAt.toISOString(),
        dto.endAt ?? slot.endAt.toISOString(),
      );
      slot.startAt = start;
      slot.endAt = end;
    }
    if (dto.capacity !== undefined && dto.capacity < slot.bookedCount) {
      throw new BadRequestException({
        code: 'CAPACITY_BELOW_BOOKED',
        message: `Slot đã có ${slot.bookedCount} lịch đặt`,
      });
    }
    if (dto.jobId !== undefined && dto.jobId !== slot.jobId) {
      if (slot.bookedCount > 0) {
        throw new ConflictException({
          code: 'SLOT_HAS_BOOKINGS',
          message: 'Slot đã có lịch đặt — không đổi vị trí được',
        });
      }
      if (dto.jobId) await this.getJobOrThrow(dto.jobId);
      slot.jobId = dto.jobId ?? null;
    }
    if (dto.interviewerId !== undefined) {
      await this.assertEmployee(dto.interviewerId);
      slot.interviewerId = dto.interviewerId ?? null;
    }
    if (dto.capacity !== undefined) slot.capacity = dto.capacity;
    if (dto.timezone !== undefined) slot.timezone = dto.timezone;
    if (dto.location !== undefined) slot.location = dto.location ?? null;
    if (dto.meetingUrl !== undefined) slot.meetingUrl = dto.meetingUrl ?? null;
    if (dto.notes !== undefined) slot.notes = dto.notes ?? null;
    if (dto.isActive !== undefined) slot.isActive = dto.isActive;

    const saved = await this.slotRepo.save(slot);
    await this.audit.record({
      actor,
      action: 'INTERVIEW_SLOT_UPDATE',
      entity: 'interview-slots',
      entityId: id,
      before,
      after: saved,
    });
    return saved;
  }

  async listSlots(
    query: QueryInterviewSlotDto,
  ): Promise<Paginated<RecruitmentInterviewSlot>> {
    const { page, limit } = query;
    const qb = this.slotRepo.createQueryBuilder('s');
    if (query.jobId) qb.andWhere('s.jobId = :jobId', { jobId: query.jobId });
    if (query.from)
      qb.andWhere('s.startAt >= :from', { from: new Date(query.from) });
    if (query.to) qb.andWhere('s.startAt <= :to', { to: new Date(query.to) });
    if (query.activeOnly) qb.andWhere('s.isActive = true');

    const [data, total] = await qb
      .orderBy('s.startAt', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  // -------------------------------------------------- interviews (HR) ----

  async create(dto: CreateInterviewDto, actor: RecruitmentActor) {
    const application = await this.getApplicationOrThrow(dto.applicationId);
    if (!HR_SCHEDULABLE.includes(application.status)) {
      throw new ConflictException({
        code: 'INTERVIEW_NOT_ALLOWED',
        message: `Hồ sơ đang ở trạng thái ${application.status}, chưa hẹn phỏng vấn được`,
      });
    }
    if (!dto.slotId && (!dto.scheduledStart || !dto.scheduledEnd)) {
      throw new BadRequestException({
        code: 'SCHEDULE_REQUIRED',
        message: 'Chọn slotId hoặc nhập scheduledStart và scheduledEnd',
      });
    }
    await this.assertEmployee(dto.interviewerId);
    await this.assertNoActiveInterview(application.id);

    const interview = await this.inTxHandlingActiveDuplicate(
      application.id,
      async (em) => {
        let start: Date;
        let end: Date;
        let slot: RecruitmentInterviewSlot | null = null;
        if (dto.slotId) {
          slot = await this.slots.reserve(em, {
            slotId: dto.slotId,
            jobId: application.jobId,
            minLeadMinutes: 0,
          });
          start = slot.startAt;
          end = slot.endAt;
        } else {
          ({ start, end } = this.parseRange(
            dto.scheduledStart!,
            dto.scheduledEnd!,
          ));
        }

        return em.getRepository(RecruitmentInterview).save(
          this.interviewRepo.create({
            applicationId: application.id,
            candidateId: application.candidateId,
            jobId: application.jobId,
            slotId: slot?.id ?? null,
            interviewerId: dto.interviewerId ?? slot?.interviewerId ?? null,
            scheduledStart: start,
            scheduledEnd: end,
            timezone: dto.timezone ?? slot?.timezone ?? 'Asia/Ho_Chi_Minh',
            location: dto.location ?? slot?.location ?? null,
            meetingUrl: dto.meetingUrl ?? slot?.meetingUrl ?? null,
            status: PROPOSED,
            notes: dto.notes ?? null,
            createdByType: RecruitmentActorType.HR,
            createdBy: actor.employeeId,
          }),
        );
      },
    );

    await this.audit.record({
      actor,
      action: 'INTERVIEW_CREATE',
      entity: 'interviews',
      entityId: interview.id,
      after: interview,
      context: {
        applicationId: application.id,
        candidateId: application.candidateId,
      },
    });
    return interview;
  }

  async findAll(
    query: QueryInterviewDto,
  ): Promise<Paginated<RecruitmentInterview>> {
    const { page, limit } = query;
    const qb = this.interviewRepo
      .createQueryBuilder('i')
      .leftJoin('i.candidate', 'c')
      .leftJoin('i.job', 'j')
      .leftJoin('i.interviewer', 'e')
      .addSelect(['c.id', 'c.fullName', 'c.phone'])
      .addSelect(['j.id', 'j.code', 'j.title'])
      .addSelect(['e.id', 'e.name']);

    if (query.applicationId)
      qb.andWhere('i.applicationId = :applicationId', {
        applicationId: query.applicationId,
      });
    if (query.candidateId)
      qb.andWhere('i.candidateId = :candidateId', {
        candidateId: query.candidateId,
      });
    if (query.jobId) qb.andWhere('i.jobId = :jobId', { jobId: query.jobId });
    if (query.status)
      qb.andWhere('i.status = :status', { status: query.status });
    if (query.from)
      qb.andWhere('i.scheduledStart >= :from', { from: new Date(query.from) });
    if (query.to)
      qb.andWhere('i.scheduledStart <= :to', { to: new Date(query.to) });

    const [data, total] = await qb
      .orderBy('i.scheduledStart', 'ASC')
      .addOrderBy('i.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const interview = await this.interviewRepo.findOne({
      where: { id },
      relations: { candidate: true, job: true, interviewer: true, slot: true },
    });
    if (!interview) throw this.notFound(id);
    const { interviewer, ...rest } = interview;
    return {
      ...rest,
      interviewer: interviewer
        ? { id: interviewer.id, name: interviewer.name }
        : null,
    };
  }

  /**
   * HR sửa lịch / đổi trạng thái. Xác nhận lịch thì hồ sơ sang INTERVIEW
   * (nếu đang QUALIFIED/NEEDS_HR_REVIEW). Huỷ thì trả chỗ cho slot. Dời giờ
   * ra khỏi slot thì slot cũng được trả chỗ.
   */
  async update(id: number, dto: UpdateInterviewDto, actor: RecruitmentActor) {
    const interview = await this.getOrThrow(id);
    const before = { ...interview };
    const now = new Date();

    if (dto.status && dto.status !== interview.status) {
      if (!INTERVIEW_TRANSITIONS[interview.status].includes(dto.status)) {
        throw new ConflictException({
          code: 'INVALID_INTERVIEW_TRANSITION',
          message: `Không thể chuyển lịch từ ${interview.status} sang ${dto.status}`,
        });
      }
      if (dto.status === CANCELLED && !dto.cancellationReason) {
        throw new BadRequestException({
          code: 'CANCELLATION_REASON_REQUIRED',
          message: 'Phải nhập lý do huỷ lịch',
        });
      }
    }

    const active = ACTIVE_STATUSES.includes(interview.status);
    const timeChanged =
      dto.scheduledStart !== undefined || dto.scheduledEnd !== undefined;
    if (timeChanged && !active) {
      throw new ConflictException({
        code: 'INTERVIEW_CLOSED',
        message: `Lịch đã ${interview.status}, không đổi giờ được`,
      });
    }
    await this.assertEmployee(dto.interviewerId);

    let applicationChange: {
      from: ApplicationStatus;
      to: ApplicationStatus;
    } | null = null;

    const saved = await this.dataSource.transaction(async (em) => {
      if (timeChanged) {
        const { start, end } = this.parseRange(
          dto.scheduledStart ?? interview.scheduledStart.toISOString(),
          dto.scheduledEnd ?? interview.scheduledEnd.toISOString(),
        );
        interview.scheduledStart = start;
        interview.scheduledEnd = end;
        if (interview.slotId) {
          await this.slots.release(em, interview.slotId);
          interview.slotId = null;
        }
      }
      if (dto.interviewerId !== undefined)
        interview.interviewerId = dto.interviewerId ?? null;
      if (dto.timezone !== undefined) interview.timezone = dto.timezone;
      if (dto.location !== undefined) interview.location = dto.location ?? null;
      if (dto.meetingUrl !== undefined)
        interview.meetingUrl = dto.meetingUrl ?? null;
      if (dto.notes !== undefined) interview.notes = dto.notes ?? null;

      if (dto.status && dto.status !== interview.status) {
        interview.status = dto.status;
        if (dto.status === CANCELLED) {
          interview.cancelledAt = now;
          interview.cancellationReason = dto.cancellationReason ?? null;
          if (interview.slotId) await this.slots.release(em, interview.slotId);
        }
        if (dto.status === CONFIRMED) {
          interview.candidateConfirmedAt ??= now;
          applicationChange = await this.moveApplicationToInterview(
            em,
            interview,
            actor,
          );
        }
      }
      return em.getRepository(RecruitmentInterview).save(interview);
    });

    await this.audit.record({
      actor,
      action: 'INTERVIEW_UPDATE',
      entity: 'interviews',
      entityId: id,
      before,
      after: saved,
      context: { applicationId: saved.applicationId, applicationChange },
    });
    return this.findOne(id);
  }

  // ---------------------------------------------------------------- AI ----

  async aiListSlots(query: AiInterviewSlotsQueryDto) {
    const job = await this.getJobOrThrow(query.jobId);
    if (job.status !== RecruitmentJobStatus.ACTIVE) {
      throw new ConflictException({
        code: 'JOB_NOT_ACTIVE',
        message: `Vị trí đang ở trạng thái ${job.status}`,
      });
    }
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + AI_SLOT_DEFAULT_WINDOW_DAYS * 86_400_000);

    const data = await this.slots.listAvailable({
      jobId: query.jobId,
      from,
      to,
      limit: query.limit ?? 20,
      minLeadMinutes: AI_SLOT_MIN_LEAD_MINUTES,
    });
    return { data };
  }

  /**
   * AI đề xuất lịch: **bắt buộc** chọn slot HR đã mở, hồ sơ phải QUALIFIED và
   * chưa có lịch đang chờ. Giữ chỗ nguyên tử trong slot. Hồ sơ chưa đổi trạng
   * thái cho tới khi ứng viên xác nhận.
   */
  async aiPropose(dto: AiProposeInterviewDto) {
    const application = await this.getApplicationOrThrow(dto.applicationId);
    const candidate = await this.candidateRepo.findOne({
      where: { id: application.candidateId },
    });
    assertAiCanAct(application, candidate);

    if (application.status !== ApplicationStatus.QUALIFIED) {
      throw new ConflictException({
        code: 'INTERVIEW_NOT_ALLOWED',
        message: `Chỉ đề xuất phỏng vấn khi hồ sơ QUALIFIED (hiện tại: ${application.status})`,
      });
    }
    await this.assertNoActiveInterview(application.id);

    const interview = await this.inTxHandlingActiveDuplicate(
      application.id,
      async (em) => {
        const slot = await this.slots.reserve(em, {
          slotId: dto.slotId,
          jobId: application.jobId,
          minLeadMinutes: AI_SLOT_MIN_LEAD_MINUTES,
        });
        return em.getRepository(RecruitmentInterview).save(
          this.interviewRepo.create({
            applicationId: application.id,
            candidateId: application.candidateId,
            jobId: application.jobId,
            slotId: slot.id,
            interviewerId: slot.interviewerId,
            scheduledStart: slot.startAt,
            scheduledEnd: slot.endAt,
            timezone: slot.timezone,
            location: slot.location,
            meetingUrl: slot.meetingUrl,
            status: PROPOSED,
            notes: dto.note ?? null,
            createdByType: RecruitmentActorType.AI,
            createdBy: null,
          }),
        );
      },
    );

    await this.audit.record({
      actor: AI_ACTOR,
      action: 'INTERVIEW_PROPOSE',
      entity: 'interviews',
      entityId: interview.id,
      after: interview,
      context: { applicationId: application.id, slotId: dto.slotId },
    });
    return { interview: toAiInterviewView(interview) };
  }

  /**
   * Ứng viên đồng ý lịch → CONFIRMED và hồ sơ QUALIFIED → INTERVIEW. Đây là
   * bước duy nhất AI được đưa hồ sơ sang INTERVIEW, và chỉ với lịch HR mở
   * (slot) hoặc HR tự hẹn.
   */
  async aiConfirm(id: number) {
    const interview = await this.getOrThrow(id);
    const application = await this.getApplicationOrThrow(
      interview.applicationId,
    );
    const candidate = await this.candidateRepo.findOne({
      where: { id: application.candidateId },
    });

    if (interview.status === CONFIRMED) {
      return {
        interview: toAiInterviewView(interview),
        alreadyConfirmed: true,
        application: { id: application.id, status: application.status },
      };
    }
    assertAiCanAct(application, candidate);
    if (interview.status !== PROPOSED) {
      throw new ConflictException({
        code: 'INTERVIEW_NOT_PROPOSED',
        message: `Lịch đang ở trạng thái ${interview.status}, không xác nhận được`,
      });
    }
    if (interview.scheduledStart <= new Date()) {
      throw new ConflictException({
        code: 'INTERVIEW_IN_PAST',
        message: 'Lịch phỏng vấn đã qua giờ — đề xuất lịch khác',
      });
    }
    if (
      application.status !== ApplicationStatus.INTERVIEW &&
      !canTransition(
        application.status,
        ApplicationStatus.INTERVIEW,
        AI_ACTOR.type,
        {
          interviewConfirmed: true,
        },
      )
    ) {
      throw new ConflictException({
        code: 'INTERVIEW_NOT_ALLOWED',
        message: `Hồ sơ đang ở trạng thái ${application.status}, không xác nhận lịch được`,
      });
    }

    const before = { ...interview };
    const applicationBefore = { ...application };
    const now = new Date();

    const saved = await this.dataSource.transaction(async (em) => {
      interview.status = CONFIRMED;
      interview.candidateConfirmedAt = now;
      if (application.status !== ApplicationStatus.INTERVIEW) {
        assertApplicationTransition(
          application.status,
          ApplicationStatus.INTERVIEW,
          AI_ACTOR.type,
          {
            interviewConfirmed: true,
          },
        );
        application.status = ApplicationStatus.INTERVIEW;
        await em.getRepository(RecruitmentApplication).save(application);
      }
      return em.getRepository(RecruitmentInterview).save(interview);
    });

    await this.audit.record({
      actor: AI_ACTOR,
      action: 'INTERVIEW_CONFIRM',
      entity: 'interviews',
      entityId: id,
      before,
      after: saved,
      context: { applicationId: application.id },
    });
    if (applicationBefore.status !== application.status) {
      await this.audit.record({
        actor: AI_ACTOR,
        action: 'APPLICATION_STATUS_CHANGE',
        entity: 'applications',
        entityId: application.id,
        before: applicationBefore,
        after: application,
        context: {
          from: applicationBefore.status,
          to: application.status,
          via: 'INTERVIEW_CONFIRM',
          interviewId: id,
        },
      });
    }

    return {
      interview: toAiInterviewView(saved),
      alreadyConfirmed: false,
      application: { id: application.id, status: application.status },
    };
  }

  // ----------------------------------------------------------- helpers ----

  private async moveApplicationToInterview(
    em: EntityManager,
    interview: RecruitmentInterview,
    actor: RecruitmentActor,
  ) {
    const repo = em.getRepository(RecruitmentApplication);
    const application = await repo.findOneOrFail({
      where: { id: interview.applicationId },
    });
    if (application.status === ApplicationStatus.INTERVIEW) return null;
    if (
      !canTransition(
        application.status,
        ApplicationStatus.INTERVIEW,
        actor.type,
      )
    )
      return null;

    const from = application.status;
    application.status = ApplicationStatus.INTERVIEW;
    application.hrReviewedAt = new Date();
    application.reviewedBy = actor.employeeId;
    await repo.save(application);
    return { from, to: ApplicationStatus.INTERVIEW };
  }

  private async inTxHandlingActiveDuplicate(
    applicationId: number,
    work: (em: EntityManager) => Promise<RecruitmentInterview>,
  ): Promise<RecruitmentInterview> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Hai request song song cùng đặt lịch cho một hồ sơ — transaction thua bị
      // rollback (kể cả phần giữ chỗ slot).
      const existing = await this.findActiveInterview(applicationId);
      throw this.activeExists(existing?.id);
    }
  }

  private async assertNoActiveInterview(applicationId: number) {
    const existing = await this.findActiveInterview(applicationId);
    if (existing) throw this.activeExists(existing.id);
  }

  private findActiveInterview(applicationId: number) {
    return this.interviewRepo.findOne({
      where: { applicationId, status: In(ACTIVE_STATUSES) },
    });
  }

  private activeExists(interviewId?: number) {
    return new ConflictException({
      code: 'ACTIVE_INTERVIEW_EXISTS',
      message: 'Hồ sơ đã có lịch phỏng vấn đang chờ/đã xác nhận',
      interviewId: interviewId ?? null,
    });
  }

  private parseRange(startIso: string, endIso: string) {
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end <= start
    ) {
      throw new BadRequestException({
        code: 'INVALID_TIME_RANGE',
        message: 'Thời gian kết thúc phải sau thời gian bắt đầu',
      });
    }
    return { start, end };
  }

  private async assertEmployee(id?: number | null) {
    if (!id) return;
    const exists = await this.employeeRepo.exists({ where: { id } });
    if (!exists) {
      throw new BadRequestException({
        code: 'EMPLOYEE_NOT_FOUND',
        message: `Không tìm thấy nhân viên #${id}`,
      });
    }
  }

  private async getOrThrow(id: number) {
    const interview = await this.interviewRepo.findOne({ where: { id } });
    if (!interview) throw this.notFound(id);
    return interview;
  }

  private async getApplicationOrThrow(id: number) {
    const application = await this.applicationRepo.findOne({ where: { id } });
    if (!application) {
      throw new NotFoundException({
        code: 'APPLICATION_NOT_FOUND',
        message: `Không tìm thấy hồ sơ ứng tuyển #${id}`,
      });
    }
    return application;
  }

  private async getJobOrThrow(id: number) {
    const job = await this.jobRepo.findOne({ where: { id } });
    if (!job) {
      throw new NotFoundException({
        code: 'JOB_NOT_FOUND',
        message: `Không tìm thấy vị trí tuyển dụng #${id}`,
      });
    }
    return job;
  }

  private notFound(id: number) {
    return new NotFoundException({
      code: 'INTERVIEW_NOT_FOUND',
      message: `Không tìm thấy lịch phỏng vấn #${id}`,
    });
  }
}
