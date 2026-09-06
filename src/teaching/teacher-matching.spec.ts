import { Repository } from 'typeorm';

import { School } from '../school/schools.entity';
import { Subject } from '../subject/subject.entity';
import { Ward } from '../ward/ward.entity';

import { Teacher } from './entities/teacher.entity';
import { TeachingSchedule } from './entities/teaching-schedule.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import {
  haversineKm,
  SlotSpec,
  TeacherMatchingService,
} from './teacher-matching.service';

/**
 * Không có tổ hợp giáo viên–trường–môn nào trong dữ liệu thật mà mọi tiêu chí
 * đều đạt, nên nhánh "đủ điều kiện" chỉ chứng minh được bằng repo giả.
 */

const SCHOOL = {
  id: 301,
  name: 'Trường Tiểu học Phước Hiệp',
  latitude: 10.9,
  longitude: 106.6,
} as School;

const WARD = { id: 501, name: 'Phường Phước Hiệp', schools: [SCHOOL] } as Ward;

const OTHER_WARD = {
  id: 999,
  name: 'Phường khác',
  schools: [{ id: 999 } as School],
} as Ward;

const SUBJECT = {
  id: 410,
  name: 'Công dân số',
  schoolId: 301,
  catalogId: 17,
} as Subject;

const SLOT: SlotSpec = {
  schoolId: 301,
  subjectId: 410,
  dayOfWeek: 2,
  startTime: '13:30',
  endTime: '14:10',
  effectiveFrom: '2025-11-10',
  effectiveTo: '2026-05-31',
  periods: 1,
};

const teacher = (over: Partial<Teacher> = {}): Teacher =>
  ({
    id: 1,
    name: 'Giáo viên',
    isActive: true,
    maxPeriodsPerWeek: 20,
    latitude: null,
    longitude: null,
    allowedWards: [WARD],
    teachableSubjectCatalogs: [{ id: 17 }],
    ...over,
  }) as Teacher;

/** Repo giả: chỉ dựng đúng những phương thức service thật sự gọi. */
function makeService(options: {
  teachers: Teacher[];
  conflicts?: {
    id: number;
    startTime: string;
    endTime: string;
    schoolName: string;
    dayOfWeek?: number;
  }[];
  weeklyPeriods?: number;
  /** Buổi dạy cụ thể (buổi lẻ / dạy bù) trùng khung giờ. */
  sessionConflicts?: {
    id: number;
    date: string;
    startTime: string;
    endTime: string;
    schoolName: string;
  }[];
  school?: School | null;
  subject?: Subject | null;
  schoolCount?: number;
  schoolsWithCoords?: number;
}) {
  const {
    teachers,
    conflicts = [],
    weeklyPeriods = 0,
    sessionConflicts = [],
    school = SCHOOL,
    subject = SUBJECT,
    schoolCount = 240,
    schoolsWithCoords = 2,
  } = options;

  const scheduleQb = {
    innerJoin: () => scheduleQb,
    select: () => scheduleQb,
    where: () => scheduleQb,
    andWhere: () => scheduleQb,
    getRawMany: async () => conflicts,
    getRawOne: async () => ({ periods: weeklyPeriods }),
  };

  const schoolQb = {
    where: () => schoolQb,
    getCount: async () => schoolsWithCoords,
  };

  const sessionQb = {
    innerJoin: () => sessionQb,
    select: () => sessionQb,
    where: () => sessionQb,
    andWhere: () => sessionQb,
    getRawMany: async () => sessionConflicts,
  };

  return new TeacherMatchingService(
    { find: async () => teachers } as unknown as Repository<Teacher>,
    {
      findOne: async () => school,
      count: async () => schoolCount,
      createQueryBuilder: () => schoolQb,
    } as unknown as Repository<School>,
    { findOne: async () => subject } as unknown as Repository<Subject>,
    {
      createQueryBuilder: () => scheduleQb,
    } as unknown as Repository<TeachingSchedule>,
    {
      createQueryBuilder: () => sessionQb,
    } as unknown as Repository<TeachingSession>,
  );
}

const reason = (c: { reasons: { code: string }[] }, code: string) =>
  c.reasons.find((r) => r.code === code)!;

describe('haversineKm', () => {
  it('tính đúng khoảng cách đã biết', () => {
    // Hai trường có toạ độ thật trong DB, cách nhau khoảng 11 km.
    const km = haversineKm(10.924796, 106.625867, 10.82513, 106.639023);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(12);
  });

  it('cùng một điểm thì bằng 0', () => {
    expect(haversineKm(10.9, 106.6, 10.9, 106.6)).toBeCloseTo(0);
  });
});

describe('bận vì buổi dạy cụ thể, không phải mẫu lặp', () => {
  it('giáo viên có buổi dạy bù trùng giờ thì KHÔNG được coi là trống', async () => {
    const service = makeService({
      teachers: [teacher()],
      // Không có mẫu lặp nào trùng...
      conflicts: [],
      // ...nhưng có một buổi dạy bù đúng khung giờ đó.
      sessionConflicts: [
        {
          id: 99,
          date: '2026-09-07',
          startTime: '07:30:00',
          endTime: '09:00:00',
          schoolName: 'TH Thái Hưng',
        },
      ],
    });

    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates[0].eligible).toBe(false);
    const free = reason(candidates[0], 'SCHEDULE_FREE');
    expect(free.kind).toBe('FAIL');
    expect(free.message).toContain('TH Thái Hưng');
  });

  it('không vướng mẫu lặp lẫn buổi dạy nào thì vẫn là trống', async () => {
    const service = makeService({ teachers: [teacher()] });
    const { candidates } = await service.findCandidates(SLOT);

    expect(reason(candidates[0], 'SCHEDULE_FREE').kind).toBe('PASS');
  });
});

describe('xếp hạng giáo viên cho một ô lịch', () => {
  it('giáo viên đạt đủ tiêu chí thì eligible và điểm cao', async () => {
    const service = makeService({ teachers: [teacher()] });
    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].eligible).toBe(true);
    expect(candidates[0].score).toBeGreaterThanOrEqual(80);
    expect(reason(candidates[0], 'ALLOWED_SCHOOL').kind).toBe('PASS');
    expect(reason(candidates[0], 'TEACHABLE_SUBJECT').kind).toBe('PASS');
    expect(reason(candidates[0], 'SCHEDULE_FREE').kind).toBe('PASS');
  });

  it('có toạ độ thì được cộng điểm khoảng cách, gần hơn thì điểm cao hơn', async () => {
    const far = makeService({
      teachers: [teacher({ id: 1, latitude: 10.75, longitude: 106.5 })],
    });
    const near = makeService({
      teachers: [teacher({ id: 2, latitude: 10.901, longitude: 106.601 })],
    });

    const [{ candidates: farOnes }, { candidates: nearOnes }] =
      await Promise.all([far.findCandidates(SLOT), near.findCandidates(SLOT)]);

    expect(nearOnes[0].distanceKm).toBeLessThan(farOnes[0].distanceKm!);
    expect(nearOnes[0].score).toBeGreaterThan(farOnes[0].score);
  });

  it('thiếu toạ độ thì báo chưa rõ, KHÔNG coi như ở xa', async () => {
    const service = makeService({ teachers: [teacher()] });
    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates[0].distanceKm).toBeNull();
    expect(reason(candidates[0], 'DISTANCE').kind).toBe('UNKNOWN');
    // Vẫn đủ điều kiện: thiếu dữ liệu vị trí không phải lý do loại người.
    expect(candidates[0].eligible).toBe(true);
  });

  it('phân biệt "chưa khai" với "đã khai nhưng không nhận trường này"', async () => {
    const service = makeService({
      teachers: [
        teacher({ id: 1, name: 'Chưa khai', allowedWards: [] }),
        teacher({
          id: 2,
          name: 'Khai trường khác',
          allowedWards: [OTHER_WARD],
        }),
      ],
    });
    const { candidates } = await service.findCandidates(SLOT);

    const chuaKhai = candidates.find((c) => c.teacherName === 'Chưa khai')!;
    const khacTruong = candidates.find(
      (c) => c.teacherName === 'Khai trường khác',
    )!;

    // Cả hai đều bị loại, nhưng lý do khác nhau nên hành động khắc phục khác
    // nhau: một bên là đi khai hồ sơ, một bên là chọn người khác.
    expect(reason(chuaKhai, 'ALLOWED_SCHOOL').kind).toBe('UNKNOWN');
    expect(reason(khacTruong, 'ALLOWED_SCHOOL').kind).toBe('FAIL');
    expect(chuaKhai.eligible).toBe(false);
    expect(khacTruong.eligible).toBe(false);
  });

  it('trùng lịch thì loại và nêu rõ lịch nào', async () => {
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 33,
          startTime: '13:30:00',
          endTime: '14:10:00',
          schoolName: 'Trường Tiểu học Phước Hiệp',
        },
      ],
    });
    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates[0].eligible).toBe(false);
    expect(candidates[0].conflicts[0].scheduleId).toBe(33);
    expect(reason(candidates[0], 'SCHEDULE_FREE').message).toContain(
      'Thứ Hai 13:30–14:10',
    );
  });

  it('vượt trần số tiết trong tuần thì loại', async () => {
    const service = makeService({
      teachers: [teacher({ maxPeriodsPerWeek: 15 })],
      weeklyPeriods: 28,
    });
    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates[0].eligible).toBe(false);
    expect(reason(candidates[0], 'WEEKLY_LOAD').message).toContain('28+1 > 15');
  });

  it('dạy ít tiết hơn thì xếp trên người đã gần đầy tải', async () => {
    const rong = makeService({ teachers: [teacher()], weeklyPeriods: 2 });
    const day = makeService({ teachers: [teacher()], weeklyPeriods: 18 });

    const [a, b] = await Promise.all([
      rong.findCandidates(SLOT),
      day.findCandidates(SLOT),
    ]);
    expect(a.candidates[0].score).toBeGreaterThan(b.candidates[0].score);
  });

  it('người đủ điều kiện luôn đứng trên người bị loại, kể cả khi điểm thấp hơn', async () => {
    const service = makeService({
      teachers: [
        // Bị loại vì không nhận trường, nhưng mọi tiêu chí mềm đều tốt.
        teacher({
          id: 1,
          name: 'Bị loại',
          allowedWards: [OTHER_WARD],
          latitude: 10.9,
          longitude: 106.6,
        }),
        teacher({ id: 2, name: 'Đủ điều kiện' }),
      ],
    });
    const { candidates } = await service.findCandidates(SLOT);

    expect(candidates[0].teacherName).toBe('Đủ điều kiện');
    expect(candidates[0].eligible).toBe(true);
  });

  it('môn chưa gắn danh mục thì không loại ai vì môn, và cảnh báo', async () => {
    const service = makeService({
      teachers: [teacher({ teachableSubjectCatalogs: [] })],
      subject: { ...SUBJECT, catalogId: null } as Subject,
    });
    const { candidates, warnings } = await service.findCandidates(SLOT);

    expect(reason(candidates[0], 'TEACHABLE_SUBJECT').kind).toBe('UNKNOWN');
    expect(candidates[0].eligible).toBe(true);
    expect(warnings.some((w) => w.includes('chưa gắn danh mục'))).toBe(true);
  });

  it('cảnh báo khi phần lớn trường chưa có toạ độ', async () => {
    const service = makeService({
      teachers: [teacher()],
      schoolCount: 240,
      schoolsWithCoords: 2,
    });
    const { warnings } = await service.findCandidates(SLOT);

    expect(
      warnings.some((w) => w.includes('238/240 trường chưa có toạ độ')),
    ).toBe(true);
  });

  it('từ chối môn không thuộc trường được hỏi', async () => {
    const service = makeService({
      teachers: [teacher()],
      subject: { ...SUBJECT, schoolId: 999 } as Subject,
    });
    await expect(service.findCandidates(SLOT)).rejects.toThrow(
      'Môn học không thuộc trường này',
    );
  });
});

describe('xếp hạng cho cả thời khoá biểu', () => {
  const slots: SlotSpec[] = [
    { ...SLOT, dayOfWeek: 2, startTime: '13:30', endTime: '14:10' },
    { ...SLOT, dayOfWeek: 3, startTime: '07:30', endTime: '08:10' },
    { ...SLOT, dayOfWeek: 4, startTime: '08:10', endTime: '08:50' },
  ];

  it('trống ở mọi ô thì vẫn đủ điều kiện', async () => {
    const service = makeService({ teachers: [teacher()] });
    const { candidates } = await service.findCandidatesForSlots(slots);

    expect(candidates[0].eligible).toBe(true);
  });

  it('bận dù chỉ một ô cũng bị loại, và nêu rõ bận mấy ô', async () => {
    // Repo giả trả cùng một trùng lịch cho mọi ô — đủ để chứng minh rằng
    // trùng ở bất kỳ ô nào cũng loại cả người, chứ không chỉ ô đầu tiên.
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 77,
          startTime: '13:30:00',
          endTime: '14:10:00',
          schoolName: 'Trường khác',
        },
      ],
    });
    const { candidates } = await service.findCandidatesForSlots(slots);

    expect(candidates[0].eligible).toBe(false);
    expect(reason(candidates[0], 'SCHEDULE_FREE').message).toContain('3/3 ô');
  });

  it('từ chối khi không có ô nào', async () => {
    const service = makeService({ teachers: [teacher()] });
    await expect(service.findCandidatesForSlots([])).rejects.toThrow(
      'Chưa có ô lịch nào',
    );
  });
});

describe('độ phủ dữ liệu tiêu chí', () => {
  it('đếm đúng số giáo viên đã khai từng tiêu chí', async () => {
    const service = makeService({
      teachers: [
        teacher({ id: 1 }),
        teacher({ id: 2, allowedWards: [], teachableSubjectCatalogs: [] }),
        teacher({ id: 3, latitude: 10.9, longitude: 106.6 }),
      ],
    });
    const coverage = await service.coverage();

    expect(coverage.teachers).toEqual({
      total: 3,
      withSchools: 2,
      withSubjects: 2,
      withCoordinates: 1,
    });
    expect(coverage.schools).toEqual({ total: 240, withCoordinates: 2 });
  });
});

describe('tra lịch đã có đụng vào các ô sắp xếp', () => {
  const slot = (
    dayOfWeek: number,
    startTime: string,
    endTime: string,
  ): SlotSpec => ({
    ...SLOT,
    dayOfWeek,
    startTime,
    endTime,
  });

  it('báo trùng khi cùng thứ và khung giờ giao nhau', async () => {
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 55,
          dayOfWeek: 2,
          startTime: '13:00:00',
          endTime: '13:40:00',
          schoolName: 'Trường THCS Bình An',
        },
      ],
    });

    const found = await service.findConflictsForSlots(1, [
      slot(2, '13:30', '14:10'),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0].schoolName).toBe('Trường THCS Bình An');
    // Giữ cả giờ của ô đang xếp lẫn giờ của lịch cũ để thông báo nói được
    // "13:30–14:10 đụng 13:00–13:40", chứ không chỉ "bị trùng".
    expect(found[0].startTime).toBe('13:30');
    expect(found[0].otherStartTime).toBe('13:00');
    expect(found[0].otherEndTime).toBe('13:40');
  });

  it('khác thứ thì không tính là trùng', async () => {
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 55,
          dayOfWeek: 3,
          startTime: '13:30:00',
          endTime: '14:10:00',
          schoolName: 'Trường khác',
        },
      ],
    });

    expect(
      await service.findConflictsForSlots(1, [slot(2, '13:30', '14:10')]),
    ).toHaveLength(0);
  });

  it('kề nhau nhưng không chồng lấn thì không tính là trùng', async () => {
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 55,
          dayOfWeek: 2,
          startTime: '12:50:00',
          endTime: '13:30:00',
          schoolName: 'Trường khác',
        },
      ],
    });

    // Tiết cũ kết thúc đúng lúc tiết mới bắt đầu — hợp lệ.
    expect(
      await service.findConflictsForSlots(1, [slot(2, '13:30', '14:10')]),
    ).toHaveLength(0);
  });

  it('bỏ qua chính mẫu lịch đang sửa', async () => {
    const service = makeService({
      teachers: [teacher()],
      conflicts: [
        {
          id: 33,
          dayOfWeek: 2,
          startTime: '13:30:00',
          endTime: '14:10:00',
          schoolName: 'Trường Tiểu học Phước Hiệp',
        },
      ],
    });

    const found = await service.findConflictsForSlots(1, [
      { ...slot(2, '13:30', '14:10'), exceptScheduleId: 33 },
    ]);
    expect(found).toHaveLength(0);
  });

  it('không có ô nào thì không truy vấn gì', async () => {
    const service = makeService({ teachers: [teacher()] });
    expect(await service.findConflictsForSlots(1, [])).toEqual([]);
  });
});
