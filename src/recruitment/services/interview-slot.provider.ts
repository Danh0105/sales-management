import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, Repository } from 'typeorm';

import { RecruitmentInterviewSlot } from '../entities/recruitment-interview-slot.entity';

export const INTERVIEW_SLOT_PROVIDER = Symbol('INTERVIEW_SLOT_PROVIDER');

/** AI chỉ được đề xuất slot bắt đầu sau ít nhất ngần này phút. */
export const AI_SLOT_MIN_LEAD_MINUTES = 60;
/** Mặc định AI xem slot trong 14 ngày tới. */
export const AI_SLOT_DEFAULT_WINDOW_DAYS = 14;

export interface AvailableSlot {
  id: number;
  jobId: number | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  location: string | null;
  meetingUrl: string | null;
  remaining: number;
}

/**
 * Nguồn khung giờ phỏng vấn. Phase 1 lấy từ bảng `recruitment_interview_slots`
 * (HR mở tay). Tích hợp Google Calendar sau này chỉ cần một implementation
 * khác của interface này — service phỏng vấn không phải viết lại.
 */
export interface InterviewSlotProvider {
  listAvailable(params: {
    jobId: number;
    from: Date;
    to: Date;
    limit: number;
    minLeadMinutes: number;
  }): Promise<AvailableSlot[]>;

  /**
   * Giữ một chỗ trong slot, nguyên tử: hai ứng viên chọn cùng slot cuối thì
   * chỉ một người được. Ném `SLOT_UNAVAILABLE` khi hết chỗ/đã đóng/sai vị trí.
   */
  reserve(
    em: EntityManager,
    params: { slotId: number; jobId: number; minLeadMinutes: number },
  ): Promise<RecruitmentInterviewSlot>;

  /** Trả lại chỗ khi lịch bị huỷ hoặc dời ra khỏi slot. */
  release(em: EntityManager, slotId: number): Promise<void>;
}

@Injectable()
export class DbInterviewSlotProvider implements InterviewSlotProvider {
  constructor(
    @InjectRepository(RecruitmentInterviewSlot)
    private readonly slotRepo: Repository<RecruitmentInterviewSlot>,
  ) {}

  async listAvailable(params: {
    jobId: number;
    from: Date;
    to: Date;
    limit: number;
    minLeadMinutes: number;
  }): Promise<AvailableSlot[]> {
    const earliest = new Date(Date.now() + params.minLeadMinutes * 60_000);
    const from = params.from > earliest ? params.from : earliest;

    const slots = await this.slotRepo
      .createQueryBuilder('s')
      .where('s.isActive = true')
      .andWhere('s.bookedCount < s.capacity')
      .andWhere('s.startAt >= :from', { from })
      .andWhere('s.startAt <= :to', { to: params.to })
      .andWhere(
        new Brackets((w) =>
          w
            .where('s.jobId IS NULL')
            .orWhere('s.jobId = :jobId', { jobId: params.jobId }),
        ),
      )
      .orderBy('s.startAt', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .take(params.limit)
      .getMany();

    return slots.map((s) => ({
      id: s.id,
      jobId: s.jobId,
      startAt: s.startAt,
      endAt: s.endAt,
      timezone: s.timezone,
      location: s.location,
      meetingUrl: s.meetingUrl,
      remaining: s.capacity - s.bookedCount,
    }));
  }

  async reserve(
    em: EntityManager,
    params: { slotId: number; jobId: number; minLeadMinutes: number },
  ): Promise<RecruitmentInterviewSlot> {
    const earliest = new Date(Date.now() + params.minLeadMinutes * 60_000);

    const result = await em
      .createQueryBuilder()
      .update(RecruitmentInterviewSlot)
      .set({ bookedCount: () => '"booked_count" + 1' })
      .where('id = :id', { id: params.slotId })
      .andWhere('"is_active" = true')
      .andWhere('"booked_count" < "capacity"')
      .andWhere('"start_at" >= :earliest', { earliest })
      .andWhere('("job_id" IS NULL OR "job_id" = :jobId)', {
        jobId: params.jobId,
      })
      .execute();

    if (!result.affected) {
      throw new ConflictException({
        code: 'SLOT_UNAVAILABLE',
        message:
          'Slot phỏng vấn không còn trống, đã đóng, quá sát giờ hoặc không dành cho vị trí này',
      });
    }

    return em.getRepository(RecruitmentInterviewSlot).findOneOrFail({
      where: { id: params.slotId },
    });
  }

  async release(em: EntityManager, slotId: number): Promise<void> {
    await em
      .createQueryBuilder()
      .update(RecruitmentInterviewSlot)
      .set({ bookedCount: () => '"booked_count" - 1' })
      .where('id = :id', { id: slotId })
      .andWhere('"booked_count" > 0')
      .execute();
  }
}
