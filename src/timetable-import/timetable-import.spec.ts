import { SchoolClass } from '../teaching/entities/school-class.entity';

import { DraftResolution } from './entities/timetable-draft.entity';
import { rank, schoolCore, schoolKind, normalize } from './text-match';
import { buildPreview, gradeLevelOf } from './timetable-preview';
import { ExtractedEntry, ExtractedTimetable } from './timetable.types';
import { validateExtraction } from './timetable-validate';

/**
 * Fixture là thời khoá biểu môn Công dân số của Trường Tiểu học Phước Hiệp —
 * dùng tờ có thật vì đáp án đúng đã được đối chiếu tay với ảnh gốc: 28 lớp,
 * 28 tiết, mỗi lớp đúng một tiết mỗi tuần.
 */
const entry = (
    dayOfWeek: number,
    session: 'SANG' | 'CHIEU',
    period: number,
    className: string,
): ExtractedEntry => ({
    dayOfWeek,
    session,
    period,
    className,
    confidence: 'high',
});

const PHUOC_HIEP_ENTRIES: ExtractedEntry[] = [
    entry(2, 'CHIEU', 1, '2/4'),
    entry(3, 'SANG', 1, '4/5'),
    entry(4, 'SANG', 1, '5/4'),
    entry(4, 'CHIEU', 1, '4/1'),
    entry(5, 'SANG', 1, '1/5'),
    entry(5, 'CHIEU', 1, '3/6'),
    entry(6, 'SANG', 1, '3/3'),

    entry(2, 'SANG', 2, '2/1'),
    entry(2, 'CHIEU', 2, '5/3'),
    entry(3, 'SANG', 2, '4/4'),
    entry(3, 'CHIEU', 2, '5/6'),
    entry(4, 'SANG', 2, '2/5'),
    entry(4, 'CHIEU', 2, '5/2'),
    entry(5, 'SANG', 2, '1/4'),
    entry(5, 'CHIEU', 2, '3/2'),
    entry(6, 'SANG', 2, '3/4'),
    entry(6, 'CHIEU', 2, '1/1'),

    entry(2, 'SANG', 3, '2/2'),
    entry(2, 'CHIEU', 3, '2/6'),
    entry(3, 'SANG', 3, '4/3'),
    entry(3, 'CHIEU', 3, '5/5'),
    entry(4, 'CHIEU', 3, '4/2'),
    entry(5, 'SANG', 3, '3/5'),
    entry(5, 'CHIEU', 3, '1/2'),
    entry(6, 'SANG', 3, '3/1'),
    entry(6, 'CHIEU', 3, '1/3'),

    entry(2, 'SANG', 4, '2/3'),
    entry(3, 'SANG', 4, '5/1'),
];

const MORNING_TIMES = [
    { session: 'SANG' as const, period: 1, startTime: '07:30', endTime: '08:10' },
    { session: 'SANG' as const, period: 2, startTime: '08:10', endTime: '08:50' },
    { session: 'SANG' as const, period: 3, startTime: '09:20', endTime: '10:00' },
    { session: 'SANG' as const, period: 4, startTime: '10:00', endTime: '10:40' },
];

const AFTERNOON_TIMES = [
    { session: 'CHIEU' as const, period: 1, startTime: '13:30', endTime: '14:10' },
    { session: 'CHIEU' as const, period: 2, startTime: '14:10', endTime: '14:50' },
    { session: 'CHIEU' as const, period: 3, startTime: '15:20', endTime: '16:00' },
];

const extracted = (over: Partial<ExtractedTimetable> = {}): ExtractedTimetable => ({
    schoolName: 'Trường Tiểu học Phước Hiệp',
    subjectName: 'Công dân số',
    schoolYear: '2025-2026',
    teacherName: null,
    effectiveFrom: '2025-11-10',
    effectiveTo: null,
    periodTimes: [...MORNING_TIMES, ...AFTERNOON_TIMES],
    entries: PHUOC_HIEP_ENTRIES,
    missing: [],
    notes: null,
    ...over,
});

const resolution = (over: Partial<DraftResolution> = {}): DraftResolution => ({
    schoolId: 301,
    schoolName: 'Trường Tiểu học Phước Hiệp',
    subjectId: 410,
    subjectName: 'Công dân số',
    teacherId: 9,
    teacherName: 'Lê Thị Hồng Diễm',
    schoolYear: '2025-2026',
    effectiveFrom: '2025-11-10',
    effectiveTo: '2026-05-31',
    effectiveToUnbounded: false,
    periodTimes: [...MORNING_TIMES, ...AFTERNOON_TIMES],
    ...over,
});

const classRow = (id: number, name: string) =>
    ({ id, name, schoolId: 301, schoolYear: '2025-2026' }) as SchoolClass;

describe('so khớp tên trường', () => {
    it('bỏ được từ chỉ loại hình để lấy phần tên riêng', () => {
        expect(schoolCore('Trường Tiểu học Phước Hiệp')).toBe('phuoc hiep');
        expect(schoolCore('MẦM NON PHƯỚC HIỆP')).toBe('phuoc hiep');
    });

    it('tách "Tiểu học Phước Hiệp" khỏi "Mầm non Phước Hiệp"', () => {
        // Hai trường này tồn tại thật và trùng khít phần tên riêng; loại hình
        // trường là thứ duy nhất phân biệt được.
        const schools = [
            { id: 301, name: 'Trường Tiểu học Phước Hiệp' },
            { id: 475, name: 'MẦM NON PHƯỚC HIỆP' },
        ];
        const wanted = 'Trường Tiểu học Phước Hiệp';
        const ranked = rank(schools, schoolCore(wanted), (s) => schoolCore(s.name), {
            bonus: (s) => (schoolKind(s.name) === schoolKind(wanted) ? 0.25 : 0),
        });

        expect(ranked[0].item.id).toBe(301);
        expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    });

    it('chuẩn hoá tên lớp không phân biệt hoa thường và dấu', () => {
        expect(normalize('2/4')).toBe('2/4');
        expect(normalize('Lá 1')).toBe('la 1');
    });
});

describe('kiểm tra lưới đọc được', () => {
    it('nhận ra mỗi lớp đúng một tiết mỗi tuần', () => {
        const { issues, stats } = validateExtraction(extracted());

        expect(stats.totalEntries).toBe(28);
        expect(stats.distinctClasses).toBe(28);
        expect(stats.oneLessonPerClass).toBe(true);
        expect(issues.filter((i) => i.level === 'ERROR')).toHaveLength(0);
    });

    it('bắt được lỗi đọc lệch hàng làm hai lớp rơi vào cùng khung giờ', () => {
        // Mô phỏng đúng kiểu sai hay gặp nhất: ảnh nghiêng khiến "3/3" bị đọc
        // tụt xuống tiết 2, nơi đã có "3/4".
        const shifted = PHUOC_HIEP_ENTRIES.map((e) =>
            e.className === '3/3' ? { ...e, period: 2 } : e,
        );
        const { issues, stats } = validateExtraction(extracted({ entries: shifted }));

        const collisions = issues.filter((i) => i.code === 'SLOT_COLLISION');
        expect(collisions).toHaveLength(1);
        expect(collisions[0].level).toBe('ERROR');
        expect(collisions[0].message).toContain('3/3');
        expect(collisions[0].message).toContain('3/4');
        expect(stats.oneLessonPerClass).toBe(true); // đếm lớp vẫn khớp...
        // ...nên phép đếm lớp một mình là chưa đủ; phải có cả kiểm trùng ô.
    });

    it('bắt được lỗi đọc trùng một lớp hai lần', () => {
        const duplicated = PHUOC_HIEP_ENTRIES.map((e) =>
            e.className === '5/1' ? { ...e, className: '5/4' } : e,
        );
        const { issues, stats } = validateExtraction(
            extracted({ entries: duplicated }),
        );

        expect(stats.oneLessonPerClass).toBe(false);
        expect(issues.some((i) => i.code === 'CLASS_REPEATED')).toBe(true);
    });

    it('chặn lại khi bảng giờ buổi chiều bị cắt khỏi ảnh', () => {
        // Đúng tình huống của tấm ảnh gốc: phần "THỜI GIAN B. CHIỀU" bị cắt.
        const { issues } = validateExtraction(
            extracted({ periodTimes: MORNING_TIMES }),
        );

        const missing = issues.filter((i) => i.code === 'PERIOD_TIME_MISSING');
        expect(missing).toHaveLength(3); // tiết 1, 2, 3 buổi chiều
        expect(missing.every((i) => i.level === 'ERROR')).toBe(true);
    });

    it('nêu tên các ô model tự nhận là đọc chưa chắc', () => {
        const uncertain = PHUOC_HIEP_ENTRIES.map((e) =>
            e.className === '1/1' ? { ...e, confidence: 'low' as const } : e,
        );
        const { issues, stats } = validateExtraction(
            extracted({ entries: uncertain }),
        );

        expect(stats.lowConfidenceEntries).toBe(1);
        const warn = issues.find((i) => i.code === 'LOW_CONFIDENCE');
        expect(warn?.message).toContain('1/1');
        expect(warn?.message).toContain('Thứ Sáu');
    });
});

describe('bảng preview trước khi xác nhận', () => {
    it('phân biệt lớp đã có với lớp sẽ tạo mới', () => {
        // Trước khi import, trường 301 mới chỉ khai đúng lớp 2/4.
        const existing = new Map([['2/4', classRow(20, '2/4')]]);
        const preview = buildPreview(extracted(), resolution(), existing);

        expect(preview.scheduleCount).toBe(28);
        expect(preview.existingClassCount).toBe(1);
        expect(preview.newClassNames).toHaveLength(27);
        expect(preview.newClassNames).not.toContain('2/4');
        expect(preview.newClassNames).toContain('1/1');
        expect(preview.canCommit).toBe(true);
    });

    it('gắn đúng khung giờ cho từng tiết', () => {
        const preview = buildPreview(extracted(), resolution(), new Map());
        const row = preview.rows.find((r) => r.className === '2/4')!;

        expect(row.dayOfWeekLabel).toBe('Thứ Hai');
        expect(row.startTime).toBe('13:30');
        expect(row.endTime).toBe('14:10');
    });

    it('chặn xác nhận khi còn thiếu giáo viên và hỏi lại đúng mục đó', () => {
        const preview = buildPreview(
            extracted(),
            resolution({ teacherId: null, teacherName: null }),
            new Map(),
        );

        expect(preview.canCommit).toBe(false);
        expect(preview.needs.map((n) => n.field)).toContain('teacherId');
    });

    it('coi "không giới hạn" là đã trả lời, không hỏi lại ngày kết thúc', () => {
        const asked = buildPreview(
            extracted(),
            resolution({ effectiveTo: null, effectiveToUnbounded: false }),
            new Map(),
        );
        expect(asked.needs.map((n) => n.field)).toContain('effectiveTo');

        const answered = buildPreview(
            extracted(),
            resolution({ effectiveTo: null, effectiveToUnbounded: true }),
            new Map(),
        );
        expect(answered.needs.map((n) => n.field)).not.toContain('effectiveTo');
        expect(answered.canCommit).toBe(true);
    });
});

describe('suy khối lớp từ tên', () => {
    it.each([
        ['2/4', 2],
        ['1A', 1],
        ['12/3', 12],
        ['Lá 1', null],
        ['99/1', null],
    ])('%s -> %s', (name, expected) => {
        expect(gradeLevelOf(name as string)).toBe(expected);
    });
});

describe('chặn khi giáo viên trùng giờ với trường khác', () => {
    const conflict = {
        dayOfWeek: 2,
        startTime: '13:30',
        endTime: '14:10',
        scheduleId: 77,
        schoolName: 'Trường THCS Bình An',
        otherStartTime: '13:00',
        otherEndTime: '13:40',
    };

    it('không trùng thì vẫn xác nhận được', () => {
        const preview = buildPreview(extracted(), resolution(), new Map());
        expect(preview.canCommit).toBe(true);
        expect(preview.teacherConflicts).toEqual([]);
    });

    it('trùng một ô là khoá luôn nút xác nhận', () => {
        const preview = buildPreview(
            extracted(),
            resolution(),
            new Map(),
            [],
            [],
            [],
            [conflict],
        );

        expect(preview.canCommit).toBe(false);
        expect(preview.blockers.some((b) => b.code === 'TEACHER_TIME_CONFLICT')).toBe(
            true,
        );
    });

    it('thông báo nêu tên trường đang giữ khung giờ đó', () => {
        const preview = buildPreview(
            extracted(),
            resolution(),
            new Map(),
            [],
            [],
            [],
            [conflict],
        );
        const blocker = preview.blockers.find(
            (b) => b.code === 'TEACHER_TIME_CONFLICT',
        )!;

        // Nhân sự phải đọc được ngay: đụng ở đâu, giờ nào, với lịch nào.
        expect(blocker.message).toContain('Thứ Hai');
        expect(blocker.message).toContain('13:30–14:10');
        expect(blocker.message).toContain('13:00–13:40');
        expect(blocker.message).toContain('Trường THCS Bình An');
    });

    it('trùng nhiều ô thì báo đủ từng ô, không gộp thành một dòng', () => {
        const preview = buildPreview(
            extracted(),
            resolution(),
            new Map(),
            [],
            [],
            [],
            [
                conflict,
                { ...conflict, dayOfWeek: 5, startTime: '07:30', endTime: '08:10' },
            ],
        );

        expect(
            preview.blockers.filter((b) => b.code === 'TEACHER_TIME_CONFLICT'),
        ).toHaveLength(2);
    });

    it('giữ nguyên các lỗi khác của lưới, không ghi đè', () => {
        // Thiếu giờ chiều (3 blocker) cộng thêm 1 trùng giờ = 4.
        const preview = buildPreview(
            extracted({ periodTimes: MORNING_TIMES }),
            resolution({ periodTimes: MORNING_TIMES }),
            new Map(),
            [],
            [],
            [],
            [conflict],
        );

        expect(
            preview.blockers.filter((b) => b.code === 'PERIOD_TIME_MISSING'),
        ).toHaveLength(3);
        expect(
            preview.blockers.filter((b) => b.code === 'TEACHER_TIME_CONFLICT'),
        ).toHaveLength(1);
    });
});
