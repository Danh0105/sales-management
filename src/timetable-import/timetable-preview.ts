import { DAY_OF_WEEK_LABELS } from '../teaching/teaching.enum';
import { SchoolClass } from '../teaching/entities/school-class.entity';
import { SlotConflict } from '../teaching/teacher-matching.service';

import { DraftResolution } from './entities/timetable-draft.entity';
import { normalize } from './text-match';
import { DaySession, ExtractedTimetable } from './timetable.types';
import {
    TimetableIssue,
    TimetableStats,
    validateExtraction,
} from './timetable-validate';

export interface PreviewRow {
    className: string;
    /** null = lớp chưa có, sẽ được tạo khi Nhân sự xác nhận. */
    classId: number | null;
    dayOfWeek: number;
    dayOfWeekLabel: string;
    session: DaySession;
    period: number;
    startTime: string | null;
    endTime: string | null;
    confidence: 'high' | 'low';
}

/** Một thông tin còn thiếu, kèm sẵn các lựa chọn để Nhân sự chọn nhanh. */
export interface PreviewNeed {
    field: keyof DraftResolution | 'periodTimes';
    question: string;
    options?: { id: number; name: string; hint?: string }[];
}

export interface TimetablePreview {
    rows: PreviewRow[];
    resolution: DraftResolution;
    /** Chi tiết từng ô đụng lịch cũ — để FE tô đỏ đúng ô trong lưới. */
    teacherConflicts: SlotConflict[];
    existingClassCount: number;
    newClassNames: string[];
    scheduleCount: number;
    stats: TimetableStats;
    blockers: TimetableIssue[];
    warnings: TimetableIssue[];
    notes: TimetableIssue[];
    needs: PreviewNeed[];
    canCommit: boolean;
}

/** "2/4" -> 2, "1A" -> 1. Ngoài khoảng 1..12 thì bỏ trống cho Nhân sự tự sửa. */
export function gradeLevelOf(className: string): number | null {
    const digits = className.trim().match(/^(\d{1,2})/);
    if (!digits) return null;
    const grade = Number(digits[1]);
    return grade >= 1 && grade <= 12 ? grade : null;
}

const timeKey = (session: DaySession, period: number) => `${session}|${period}`;

export function buildPreview(
    extracted: ExtractedTimetable,
    resolution: DraftResolution,
    existingClasses: Map<string, SchoolClass>,
    teacherOptions: { id: number; name: string; hint?: string }[] = [],
    schoolOptions: { id: number; name: string; hint?: string }[] = [],
    subjectOptions: { id: number; name: string; hint?: string }[] = [],
    /**
     * Lịch đã có của giáo viên đụng vào các ô sắp xếp. Tính ở tầng service vì
     * cần truy vấn database; hàm này giữ nguyên tính thuần tuý để test được.
     */
    teacherConflicts: SlotConflict[] = [],
): TimetablePreview {
    const { issues, stats } = validateExtraction({
        ...extracted,
        // Giờ tiết đã được bổ sung qua chat cũng tính là "đã có", nên validate
        // trên bản đã gộp chứ không phải bản gốc đọc từ ảnh.
        periodTimes: resolution.periodTimes,
    });

    const times = new Map(
        resolution.periodTimes.map((t) => [timeKey(t.session, t.period), t]),
    );

    const rows: PreviewRow[] = (extracted.entries ?? [])
        .map((entry) => {
            const time = times.get(timeKey(entry.session, entry.period));
            const existing = existingClasses.get(normalize(entry.className));
            return {
                className: entry.className.trim(),
                classId: existing?.id ?? null,
                dayOfWeek: entry.dayOfWeek,
                dayOfWeekLabel:
                    DAY_OF_WEEK_LABELS[entry.dayOfWeek] ?? `Thứ ${entry.dayOfWeek}`,
                session: entry.session,
                period: entry.period,
                startTime: time?.startTime ?? null,
                endTime: time?.endTime ?? null,
                confidence: entry.confidence,
            };
        })
        .sort(
            (a, b) =>
                a.dayOfWeek - b.dayOfWeek ||
                a.session.localeCompare(b.session) ||
                a.period - b.period,
        );

    const newClassNames = [
        ...new Set(rows.filter((r) => r.classId === null).map((r) => r.className)),
    ].sort();

    const needs = collectNeeds(resolution, rows, {
        teacherOptions,
        schoolOptions,
        subjectOptions,
    });

    // Trùng giờ với lịch đã có là lỗi chặn, không phải cảnh báo: giáo viên
    // không thể ở hai trường cùng lúc, và để commit thì `TeachingBulkService`
    // cũng sẽ từ chối từng dòng — chặn sớm ở đây thì Nhân sự biết ngay, thay vì
    // bấm xác nhận rồi mới nhận một danh sách SKIPPED khó hiểu.
    const conflictIssues: TimetableIssue[] = teacherConflicts.map((conflict) => ({
        level: 'ERROR' as const,
        code: 'TEACHER_TIME_CONFLICT',
        message:
            `${DAY_OF_WEEK_LABELS[conflict.dayOfWeek] ?? `Thứ ${conflict.dayOfWeek}`} ` +
            `${conflict.startTime}–${conflict.endTime}: giáo viên đã có lịch ` +
            `${conflict.otherStartTime}–${conflict.otherEndTime} tại ${conflict.schoolName}`,
    }));

    const blockers = [...issues.filter((i) => i.level === 'ERROR'), ...conflictIssues];

    return {
        rows,
        resolution,
        teacherConflicts,
        existingClassCount: new Set(
            rows.filter((r) => r.classId !== null).map((r) => r.classId),
        ).size,
        newClassNames,
        scheduleCount: rows.length,
        stats,
        blockers,
        warnings: issues.filter((i) => i.level === 'WARN'),
        notes: issues.filter((i) => i.level === 'INFO'),
        needs,
        canCommit: blockers.length === 0 && needs.length === 0 && rows.length > 0,
    };
}

function collectNeeds(
    resolution: DraftResolution,
    rows: PreviewRow[],
    options: {
        teacherOptions: { id: number; name: string; hint?: string }[];
        schoolOptions: { id: number; name: string; hint?: string }[];
        subjectOptions: { id: number; name: string; hint?: string }[];
    },
): PreviewNeed[] {
    const needs: PreviewNeed[] = [];

    if (!resolution.schoolId) {
        needs.push({
            field: 'schoolId',
            question: 'Thời khoá biểu này của trường nào?',
            options: options.schoolOptions,
        });
    }

    if (!resolution.schoolYear) {
        needs.push({ field: 'schoolYear', question: 'Năm học nào? (VD: 2025-2026)' });
    }

    // Môn là bản ghi riêng của từng trường nên chỉ hỏi được sau khi có trường.
    if (resolution.schoolId && !resolution.subjectId) {
        needs.push({
            field: 'subjectId',
            question: 'Môn nào của trường này?',
            options: options.subjectOptions,
        });
    }

    if (!resolution.teacherId) {
        needs.push({
            field: 'teacherId',
            question: 'Giáo viên nào dạy thời khoá biểu này?',
            options: options.teacherOptions,
        });
    }

    if (!resolution.effectiveFrom) {
        needs.push({
            field: 'effectiveFrom',
            question: 'Lịch áp dụng từ ngày nào?',
        });
    }

    if (!resolution.effectiveTo && !resolution.effectiveToUnbounded) {
        needs.push({
            field: 'effectiveTo',
            question:
                'Lịch áp dụng đến ngày nào? (trả lời "không giới hạn" nếu chưa chốt)',
        });
    }

    const missingTimes = [
        ...new Set(
            rows
                .filter((r) => !r.startTime)
                .map((r) => `${r.session === 'SANG' ? 'sáng' : 'chiều'} tiết ${r.period}`),
        ),
    ];
    if (missingTimes.length > 0) {
        needs.push({
            field: 'periodTimes',
            question: `Chưa có khung giờ cho: ${missingTimes.join(', ')}. Giờ bắt đầu và kết thúc là bao nhiêu?`,
        });
    }

    return needs;
}
