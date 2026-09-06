import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { School } from '../school/schools.entity';
import { Subject } from '../subject/subject.entity';

import { Teacher } from './entities/teacher.entity';
import { TeachingSchedule } from './entities/teaching-schedule.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import {
  ConfirmationStatus,
  DAY_OF_WEEK_LABELS,
  SessionStatus,
} from './teaching.enum';
import { toDateString, toDbTime, toDisplayTime } from './teaching.util';

/** Một ô lịch cần tìm giáo viên. Chưa cần tồn tại trong database. */
export interface SlotSpec {
  schoolId: number;
  subjectId: number;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  periods?: number;
  /** Bỏ qua khi xét trùng lịch — dùng khi đang đổi giáo viên của chính mẫu này. */
  exceptScheduleId?: number;
}

export type ReasonKind = 'PASS' | 'FAIL' | 'UNKNOWN';

export interface MatchReason {
  kind: ReasonKind;
  code:
    | 'ALLOWED_SCHOOL'
    | 'TEACHABLE_SUBJECT'
    | 'SCHEDULE_FREE'
    | 'WEEKLY_LOAD'
    | 'DISTANCE';
  message: string;
}

export interface TeacherCandidate {
  teacherId: number;
  teacherName: string;
  defaultRatePerPeriod: number | null;
  /** 0–100. Chỉ so sánh được giữa các ứng viên của cùng một ô lịch. */
  score: number;
  eligible: boolean;
  reasons: MatchReason[];
  distanceKm: number | null;
  assignedPeriodsInWeek: number;
  maxPeriodsPerWeek: number | null;
  conflicts: { scheduleId: number; label: string }[];
}

/** Một ô lịch đụng vào một mẫu lịch đã có của chính giáo viên đó. */
export interface SlotConflict {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  scheduleId: number;
  /** Trường đang giữ khung giờ đó — thường là trường khác. */
  schoolName: string;
  otherStartTime: string;
  otherEndTime: string;
}

export interface MatchCoverage {
  teachers: {
    total: number;
    withSchools: number;
    withSubjects: number;
    withCoordinates: number;
  };
  schools: { total: number; withCoordinates: number };
}

/** Điểm tối đa của từng tiêu chí; tổng đúng 100. */
const WEIGHT = { subject: 40, school: 25, load: 20, distance: 15 };

/** Xa hơn mức này thì phần điểm khoảng cách về 0. */
const MAX_USEFUL_DISTANCE_KM = 30;

/**
 * Chấm điểm giáo viên cho một ô lịch, dựa trên tiêu chí đã khai trong hồ sơ:
 * trường được dạy, môn được dạy, khoảng cách, tải trong tuần.
 *
 * Đây là mô hình **đẩy** — có lịch trống thì đi tìm giáo viên. Khác với
 * `TeachingSessionService.suggestions()` là mô hình **kéo**: giáo viên tự đăng
 * ký vào tiết đang mở rồi Nhân sự chọn trong số người đã đăng ký. Hai luồng tồn
 * tại song song vì phục vụ hai tình huống khác nhau.
 *
 * Service chỉ **xếp hạng**, không tự gán. Việc gán vẫn đi qua endpoint sẵn có
 * để giữ nguyên mọi kiểm tra nghiệp vụ.
 */
@Injectable()
export class TeacherMatchingService {
  constructor(
    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,
    @InjectRepository(School)
    private readonly schoolRepo: Repository<School>,
    @InjectRepository(Subject)
    private readonly subjectRepo: Repository<Subject>,
    @InjectRepository(TeachingSchedule)
    private readonly scheduleRepo: Repository<TeachingSchedule>,

    // Đặt cuối danh sách: test dựng service bằng tham số vị trí, chèn vào giữa
    // là đẩy lệch mọi dependency phía sau.
    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,
  ) {}

  async findCandidates(slot: SlotSpec): Promise<{
    candidates: TeacherCandidate[];
    coverage: MatchCoverage;
    warnings: string[];
  }> {
    const school = await this.schoolRepo.findOne({
      where: { id: slot.schoolId },
    });
    if (!school) throw new BadRequestException('Trường không tồn tại');

    const subject = await this.subjectRepo.findOne({
      where: { id: slot.subjectId },
    });
    if (!subject) throw new BadRequestException('Môn học không tồn tại');
    if (subject.schoolId !== slot.schoolId) {
      throw new BadRequestException('Môn học không thuộc trường này');
    }

    const teachers = await this.teacherRepo.find({
      where: { isActive: true },
      relations: [
        'allowedWards',
        'allowedWards.schools',
        'teachableSubjectCatalogs',
      ],
    });

    const candidates = await Promise.all(
      teachers.map((teacher) => this.score(teacher, slot, school, subject)),
    );

    // Đủ điều kiện lên trước; trong cùng nhóm thì điểm cao lên trước. Không
    // loại hẳn người không đủ điều kiện — Nhân sự cần thấy vì sao họ bị loại.
    candidates.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        a.teacherName.localeCompare(b.teacherName, 'vi'),
    );

    const coverage = await this.coverage();
    return {
      candidates,
      coverage,
      warnings: this.warnings(coverage, subject),
    };
  }

  /**
   * Xếp hạng cho **cả một thời khoá biểu**: giáo viên phải trống ở *mọi* ô,
   * không phải chỉ một ô.
   *
   * Dùng cho luồng nhập từ ảnh, nơi 28 ô được giao cho cùng một giáo viên.
   * Xếp hạng từng ô riêng lẻ sẽ đề xuất người bận ở 27 ô còn lại.
   */
  async findCandidatesForSlots(slots: SlotSpec[]): Promise<{
    candidates: TeacherCandidate[];
    coverage: MatchCoverage;
    warnings: string[];
  }> {
    if (slots.length === 0) throw new BadRequestException('Chưa có ô lịch nào');

    const base = slots[0];
    const { candidates, coverage, warnings } = await this.findCandidates(base);

    // Trường/môn/khoảng cách/tải giống nhau ở mọi ô nên chỉ cần chấm một
    // lần; riêng trùng lịch phải kiểm từng ô.
    const merged = await Promise.all(
      candidates.map(async (candidate) => {
        const conflicts = (
          await Promise.all(
            slots.map((slot) => this.findConflicts(candidate.teacherId, slot)),
          )
        ).flat();

        if (conflicts.length === 0) return candidate;

        return {
          ...candidate,
          eligible: false,
          conflicts,
          reasons: candidate.reasons.map((reason) =>
            reason.code === 'SCHEDULE_FREE'
              ? {
                  kind: 'FAIL' as const,
                  code: 'SCHEDULE_FREE' as const,
                  message: `Trùng ${conflicts.length}/${slots.length} ô: ${conflicts[0].label}`,
                }
              : reason,
          ),
        };
      }),
    );

    merged.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score ||
        a.teacherName.localeCompare(b.teacherName, 'vi'),
    );

    return { candidates: merged, coverage, warnings };
  }

  /**
   * Lịch đã có của giáo viên đụng vào từng ô trong danh sách — dùng để chặn
   * việc xếp cả một thời khoá biểu lên giờ giáo viên đã bận ở trường khác.
   *
   * Nạp **một lần** toàn bộ lịch còn hiệu lực của giáo viên rồi đối chiếu
   * trong bộ nhớ, thay vì mỗi ô một truy vấn: hàm này chạy lại ở mọi lượt chat
   * và mọi lần mở bản nháp, mà một thời khoá biểu có tới vài chục ô.
   */
  async findConflictsForSlots(
    teacherId: number,
    slots: SlotSpec[],
  ): Promise<SlotConflict[]> {
    if (slots.length === 0) return [];

    const from = slots.reduce(
      (min, s) => (s.effectiveFrom < min ? s.effectiveFrom : min),
      slots[0].effectiveFrom,
    );
    const to = slots.some((s) => !s.effectiveTo)
      ? '9999-12-31'
      : slots.reduce(
          (max, s) => (s.effectiveTo! > max ? s.effectiveTo! : max),
          slots[0].effectiveTo!,
        );

    const existing = await this.scheduleRepo
      .createQueryBuilder('s')
      .innerJoin('s.school', 'sc')
      .select([
        's.id AS "id"',
        's.dayOfWeek AS "dayOfWeek"',
        's.startTime AS "startTime"',
        's.endTime AS "endTime"',
        'sc.name AS "schoolName"',
      ])
      .where('s.teacherId = :teacherId', { teacherId })
      .andWhere('s.isActive = true')
      .andWhere('s.confirmationStatus != :rejectedStatus', {
        rejectedStatus: ConfirmationStatus.REJECTED,
      })
      .andWhere('s.effectiveFrom <= :to', { to })
      .andWhere('(s.effectiveTo IS NULL OR s.effectiveTo >= :from)', {
        from,
      })
      .getRawMany();

    const conflicts: SlotConflict[] = [];

    for (const slot of slots) {
      const slotStart = toDbTime(slot.startTime);
      const slotEnd = toDbTime(slot.endTime);

      for (const row of existing) {
        if (Number(row.dayOfWeek) !== slot.dayOfWeek) continue;
        if (slot.exceptScheduleId === Number(row.id)) continue;
        // Giao nhau khi bắt đầu của bên này trước khi kết thúc của bên kia.
        if (!(row.startTime < slotEnd && row.endTime > slotStart)) continue;

        conflicts.push({
          dayOfWeek: slot.dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          scheduleId: Number(row.id),
          schoolName: row.schoolName,
          otherStartTime: toDisplayTime(row.startTime) ?? '',
          otherEndTime: toDisplayTime(row.endTime) ?? '',
        });
      }
    }

    return conflicts;
  }

  /** Độ phủ dữ liệu tiêu chí — thiếu thì việc xếp hạng mất ý nghĩa. */
  async coverage(): Promise<MatchCoverage> {
    const teachers = await this.teacherRepo.find({
      where: { isActive: true },
      relations: [
        'allowedWards',
        'allowedWards.schools',
        'teachableSubjectCatalogs',
      ],
    });

    const [schoolTotal, schoolWithCoords] = await Promise.all([
      this.schoolRepo.count(),
      this.schoolRepo
        .createQueryBuilder('s')
        .where('s.latitude IS NOT NULL AND s.longitude IS NOT NULL')
        .getCount(),
    ]);

    return {
      teachers: {
        total: teachers.length,
        withSchools: teachers.filter((t) => this.allowedSchoolsOf(t).length > 0)
          .length,
        withSubjects: teachers.filter(
          (t) => (t.teachableSubjectCatalogs ?? []).length > 0,
        ).length,
        withCoordinates: teachers.filter(
          (t) => t.latitude != null && t.longitude != null,
        ).length,
      },
      schools: { total: schoolTotal, withCoordinates: schoolWithCoords },
    };
  }

  /** Trường giáo viên được dạy, suy ra động từ các xã/phường đã gán (`allowedWards`). */
  private allowedSchoolsOf(teacher: Teacher): School[] {
    const byId = new Map<number, School>();
    (teacher.allowedWards ?? []).forEach((ward) => {
      (ward.schools ?? []).forEach((school) => byId.set(school.id, school));
    });
    return [...byId.values()];
  }

  private warnings(coverage: MatchCoverage, subject: Subject): string[] {
    const out: string[] = [];

    if (coverage.schools.withCoordinates < coverage.schools.total) {
      const missing = coverage.schools.total - coverage.schools.withCoordinates;
      out.push(
        `${missing}/${coverage.schools.total} trường chưa có toạ độ — tiêu chí khoảng cách chỉ áp dụng được cho phần còn lại`,
      );
    }

    if (coverage.teachers.withSchools < coverage.teachers.total) {
      out.push(
        `${coverage.teachers.total - coverage.teachers.withSchools}/${coverage.teachers.total} giáo viên chưa khai trường được dạy nên bị loại khỏi mọi đề xuất`,
      );
    }

    if (subject.catalogId == null) {
      out.push(
        `Môn "${subject.name}" chưa gắn danh mục môn dùng chung nên không đối chiếu được năng lực môn của giáo viên`,
      );
    }

    return out;
  }

  private async score(
    teacher: Teacher,
    slot: SlotSpec,
    school: School,
    subject: Subject,
  ): Promise<TeacherCandidate> {
    const reasons: MatchReason[] = [];
    let score = 0;
    let eligible = true;

    // --- Tiêu chí cứng: trường được dạy (suy ra từ xã/phường đã gán) ---
    const allowedSchools = this.allowedSchoolsOf(teacher);
    if (allowedSchools.some((s) => s.id === slot.schoolId)) {
      score += WEIGHT.school;
      reasons.push({
        kind: 'PASS',
        code: 'ALLOWED_SCHOOL',
        message: `Nhận dạy tại ${school.name}`,
      });
    } else if (allowedSchools.length === 0) {
      eligible = false;
      reasons.push({
        kind: 'UNKNOWN',
        code: 'ALLOWED_SCHOOL',
        message: 'Chưa khai trường được dạy trong hồ sơ',
      });
    } else {
      eligible = false;
      reasons.push({
        kind: 'FAIL',
        code: 'ALLOWED_SCHOOL',
        message: `Không nhận dạy tại ${school.name}`,
      });
    }

    // --- Tiêu chí cứng: môn được dạy ---
    const catalogIds = (teacher.teachableSubjectCatalogs ?? []).map(
      (c) => c.id,
    );
    if (subject.catalogId == null) {
      // Lỗi khai báo của môn, không phải của giáo viên — không loại ai cả.
      reasons.push({
        kind: 'UNKNOWN',
        code: 'TEACHABLE_SUBJECT',
        message: `Môn "${subject.name}" chưa gắn danh mục nên không đối chiếu được`,
      });
    } else if (catalogIds.includes(subject.catalogId)) {
      score += WEIGHT.subject;
      reasons.push({
        kind: 'PASS',
        code: 'TEACHABLE_SUBJECT',
        message: `Dạy được môn ${subject.name}`,
      });
    } else if (catalogIds.length === 0) {
      eligible = false;
      reasons.push({
        kind: 'UNKNOWN',
        code: 'TEACHABLE_SUBJECT',
        message: 'Chưa khai môn được dạy trong hồ sơ',
      });
    } else {
      eligible = false;
      reasons.push({
        kind: 'FAIL',
        code: 'TEACHABLE_SUBJECT',
        message: `Không dạy môn ${subject.name}`,
      });
    }

    // --- Tiêu chí cứng: không trùng lịch ---
    const conflicts = await this.findConflicts(teacher.id, slot);
    if (conflicts.length > 0) {
      eligible = false;
      reasons.push({
        kind: 'FAIL',
        code: 'SCHEDULE_FREE',
        message: `Đã có lịch ${conflicts[0].label}`,
      });
    } else {
      reasons.push({
        kind: 'PASS',
        code: 'SCHEDULE_FREE',
        message: 'Khung giờ này đang trống',
      });
    }

    // --- Tiêu chí mềm: tải trong tuần ---
    const assignedPeriodsInWeek = await this.weeklyPeriods(teacher.id, slot);
    const max = teacher.maxPeriodsPerWeek ?? null;
    const periods = slot.periods ?? 1;

    if (max === null) {
      // Chưa khai trần thì không suy ra được đang rảnh hay quá tải; cho
      // nửa điểm để không thiên vị lẫn trừng phạt.
      score += WEIGHT.load / 2;
      reasons.push({
        kind: 'UNKNOWN',
        code: 'WEEKLY_LOAD',
        message: `Đang dạy ${assignedPeriodsInWeek} tiết/tuần, chưa khai trần số tiết`,
      });
    } else if (assignedPeriodsInWeek + periods > max) {
      eligible = false;
      reasons.push({
        kind: 'FAIL',
        code: 'WEEKLY_LOAD',
        message: `Vượt trần: ${assignedPeriodsInWeek}+${periods} > ${max} tiết/tuần`,
      });
    } else {
      const room = (max - assignedPeriodsInWeek - periods) / max;
      score += WEIGHT.load * room;
      reasons.push({
        kind: 'PASS',
        code: 'WEEKLY_LOAD',
        message: `${assignedPeriodsInWeek}/${max} tiết trong tuần, còn nhận thêm được`,
      });
    }

    // --- Tiêu chí mềm: khoảng cách ---
    const distanceKm = this.distanceKm(teacher, school);
    if (distanceKm === null) {
      // Không đoán. Thiếu toạ độ thì phần điểm này bằng 0 và nói rõ lý do,
      // chứ không coi như ở xa cũng không coi như ở gần.
      reasons.push({
        kind: 'UNKNOWN',
        code: 'DISTANCE',
        message:
          teacher.latitude == null
            ? 'Chưa có vị trí giáo viên'
            : `Trường ${school.name} chưa có toạ độ`,
      });
    } else {
      const closeness = Math.max(0, 1 - distanceKm / MAX_USEFUL_DISTANCE_KM);
      score += WEIGHT.distance * closeness;
      reasons.push({
        kind: 'PASS',
        code: 'DISTANCE',
        message: `Cách trường ${distanceKm.toFixed(1)} km`,
      });
    }

    return {
      teacherId: teacher.id,
      teacherName: teacher.name,
      defaultRatePerPeriod: teacher.defaultRatePerPeriod ?? null,
      score: Math.round(score),
      eligible,
      reasons,
      distanceKm,
      assignedPeriodsInWeek,
      maxPeriodsPerWeek: max,
      conflicts,
    };
  }

  /**
   * Giáo viên có bận khung giờ này không — xét CẢ HAI nguồn:
   *
   * 1. **Mẫu lặp tuần** (`teaching_schedules`): cùng thứ, khung giờ giao nhau,
   *    khoảng hiệu lực giao nhau (`effectiveTo` null = vô hạn). Cùng điều kiện
   *    với `assertNoScheduleConflict`, nên người được đề xuất ở đây sẽ không bị
   *    chính endpoint tạo lịch từ chối.
   * 2. **Buổi dạy cụ thể** (`teaching_sessions`): buổi lẻ và buổi dạy bù không
   *    sinh ra từ mẫu nào. Bỏ qua nguồn này thì giáo viên đang có buổi dạy bù
   *    đúng khung giờ vẫn bị báo là "đang trống" và Nhân sự xếp trùng người.
   */
  private async findConflicts(
    teacherId: number,
    slot: SlotSpec,
  ): Promise<{ scheduleId: number; label: string }[]> {
    const qb = this.scheduleRepo
      .createQueryBuilder('s')
      .innerJoin('s.school', 'sc')
      .select([
        's.id AS "id"',
        's.startTime AS "startTime"',
        's.endTime AS "endTime"',
        'sc.name AS "schoolName"',
      ])
      .where('s.teacherId = :teacherId', { teacherId })
      .andWhere('s.dayOfWeek = :dayOfWeek', { dayOfWeek: slot.dayOfWeek })
      .andWhere('s.isActive = true')
      .andWhere('s.confirmationStatus != :rejectedStatus', {
        rejectedStatus: ConfirmationStatus.REJECTED,
      })
      .andWhere('s.effectiveFrom <= :candidateTo', {
        candidateTo: slot.effectiveTo ?? '9999-12-31',
      })
      .andWhere('(s.effectiveTo IS NULL OR s.effectiveTo >= :candidateFrom)', {
        candidateFrom: slot.effectiveFrom,
      })
      .andWhere('s.startTime < :endTime', {
        endTime: toDbTime(slot.endTime),
      })
      .andWhere('s.endTime > :startTime', {
        startTime: toDbTime(slot.startTime),
      });

    if (slot.exceptScheduleId) {
      qb.andWhere('s.id != :exceptId', {
        exceptId: slot.exceptScheduleId,
      });
    }

    const rows = await qb.getRawMany();
    const fromSchedules = rows.map((row) => ({
      scheduleId: Number(row.id),
      label:
        `${DAY_OF_WEEK_LABELS[slot.dayOfWeek]} ` +
        `${toDisplayTime(row.startTime)}–${toDisplayTime(row.endTime)} ` +
        `tại ${row.schoolName}`,
    }));

    const fromSessions = await this.findSessionConflicts(teacherId, slot);
    return [...fromSchedules, ...fromSessions];
  }

  /**
   * Buổi dạy đã xếp cho giáo viên rơi đúng thứ + khung giờ của ô đang xét,
   * trong khoảng hiệu lực của mẫu sắp tạo.
   *
   * `ISODOW` của Postgres đánh 1=Thứ Hai…7=Chủ Nhật, còn hệ thống dùng
   * 2=Thứ Hai…8=Chủ Nhật, nên cộng 1 để quy về cùng hệ.
   *
   * Buổi sinh từ mẫu lặp cũng nằm ở đây, nhưng trùng lặp không gây hại: kết quả
   * chỉ dùng để đánh dấu "bận" và lấy nhãn đầu tiên làm lý do.
   */
  private async findSessionConflicts(
    teacherId: number,
    slot: SlotSpec,
  ): Promise<{ scheduleId: number; label: string }[]> {
    const rows = await this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.school', 'sc')
      .select([
        'ss.id AS "id"',
        'ss.date AS "date"',
        'ss.startTime AS "startTime"',
        'ss.endTime AS "endTime"',
        'sc.name AS "schoolName"',
      ])
      .where('ss.teacherId = :teacherId', { teacherId })
      .andWhere('EXTRACT(ISODOW FROM ss.date) + 1 = :dayOfWeek', {
        dayOfWeek: slot.dayOfWeek,
      })
      .andWhere('ss.date >= :candidateFrom', {
        candidateFrom: slot.effectiveFrom,
      })
      .andWhere('ss.date <= :candidateTo', {
        candidateTo: slot.effectiveTo ?? '9999-12-31',
      })
      // Buổi đã huỷ không chiếm chỗ.
      .andWhere('ss.status != :cancelled', {
        cancelled: SessionStatus.CANCELLED,
      })
      .andWhere('ss.startTime < :endTime', { endTime: toDbTime(slot.endTime) })
      .andWhere('ss.endTime > :startTime', {
        startTime: toDbTime(slot.startTime),
      })
      .getRawMany();

    return rows.map((row) => ({
      scheduleId: Number(row.id),
      label:
        `${DAY_OF_WEEK_LABELS[slot.dayOfWeek]} ` +
        `${toDisplayTime(row.startTime)}–${toDisplayTime(row.endTime)} ` +
        `tại ${row.schoolName} (buổi ngày ${toDateString(row.date)})`,
    }));
  }

  /** Tổng số tiết/tuần từ các mẫu lịch còn hiệu lực trong khoảng của ô này. */
  private async weeklyPeriods(
    teacherId: number,
    slot: SlotSpec,
  ): Promise<number> {
    const qb = this.scheduleRepo
      .createQueryBuilder('s')
      .select('COALESCE(SUM(COALESCE(s.periods, 1)), 0)', 'periods')
      .where('s.teacherId = :teacherId', { teacherId })
      .andWhere('s.isActive = true')
      .andWhere('s.confirmationStatus != :rejectedStatus', {
        rejectedStatus: ConfirmationStatus.REJECTED,
      })
      .andWhere('s.effectiveFrom <= :candidateTo', {
        candidateTo: slot.effectiveTo ?? '9999-12-31',
      })
      .andWhere('(s.effectiveTo IS NULL OR s.effectiveTo >= :candidateFrom)', {
        candidateFrom: slot.effectiveFrom,
      });

    if (slot.exceptScheduleId) {
      qb.andWhere('s.id != :exceptId', {
        exceptId: slot.exceptScheduleId,
      });
    }

    const row = await qb.getRawOne();
    return Number(row?.periods ?? 0);
  }

  private distanceKm(teacher: Teacher, school: School): number | null {
    if (
      teacher.latitude == null ||
      teacher.longitude == null ||
      school.latitude == null ||
      school.longitude == null
    ) {
      return null;
    }
    return haversineKm(
      teacher.latitude,
      teacher.longitude,
      school.latitude,
      school.longitude,
    );
  }
}

/** Khoảng cách đường chim bay (km). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
