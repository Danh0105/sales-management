import { DAY_OF_WEEK_LABELS } from '../teaching/teaching.enum';

import { ExtractedTimetable, DaySession } from './timetable.types';

/**
 * Kiểm tra kết quả đọc ảnh bằng **code**, không hỏi lại model.
 *
 * Một tờ thời khoá biểu có các bất biến đếm được, và chúng bắt được đúng loại
 * lỗi mà model dễ mắc nhất: đọc lệch một hàng thì hai lớp rơi vào cùng một ô
 * giờ, hoặc một lớp bị đọc hai lần. Model tự chấm bài của mình thì không phát
 * hiện được — phép đếm thì có.
 */

/**
 * Chuẩn hoá giờ model đọc được về dạng "HH:mm".
 *
 * Trên tờ thời khoá biểu người Việt viết giờ theo nhiều kiểu — "7h00", "7h",
 * "7g30", "7.30" — và model trả lại đúng như thế dù prompt yêu cầu "HH:mm".
 * Để nguyên thì hỏng ở tầng dưới: giờ được so sánh dạng CHUỖI, nên "9h45" bị
 * coi là lớn hơn "14h00" (ký tự '9' > '1') và cả lịch bị từ chối với thông báo
 * khó hiểu "startTime phải nhỏ hơn endTime".
 *
 * Trả `null` khi không nhận diện được, để nơi gọi tự quyết định bỏ qua hay báo lỗi.
 */
export function normalizeTimeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const raw = value.trim();
    if (!raw) return null;

    // "7h00" | "7h" | "7g30" | "7.30" | "7:30" | "07:30" | "07:30:00"
    const matched = raw.match(/^(\d{1,2})\s*[:hg.]\s*(\d{1,2})?(?::\d{1,2})?$/i);
    if (!matched) return null;

    const hour = Number(matched[1]);
    const minute = matched[2] === undefined ? 0 : Number(matched[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export type IssueLevel = 'ERROR' | 'WARN' | 'INFO';

export interface TimetableIssue {
    level: IssueLevel;
    code: string;
    message: string;
}

export interface TimetableStats {
    totalEntries: number;
    distinctClasses: number;
    lowConfidenceEntries: number;
    /**
     * Mỗi lớp xuất hiện đúng một lần. Với môn học 1 tiết/tuần thì đây là dấu
     * hiệu mạnh nhất cho thấy cả lưới đã đọc đúng.
     */
    oneLessonPerClass: boolean;
}

const sessionLabel = (session: DaySession) =>
    session === 'SANG' ? 'sáng' : 'chiều';

const slotKey = (dayOfWeek: number, session: DaySession, period: number) =>
    `${dayOfWeek}|${session}|${period}`;

const slotLabel = (dayOfWeek: number, session: DaySession, period: number) =>
    `${DAY_OF_WEEK_LABELS[dayOfWeek] ?? `Thứ ${dayOfWeek}`} ${sessionLabel(session)} tiết ${period}`;

export function validateExtraction(data: ExtractedTimetable): {
    issues: TimetableIssue[];
    stats: TimetableStats;
} {
    const issues: TimetableIssue[] = [];
    const entries = data.entries ?? [];

    const classCounts = new Map<string, number>();
    const slotOccupants = new Map<string, string[]>();

    for (const entry of entries) {
        const name = entry.className.trim();
        classCounts.set(name, (classCounts.get(name) ?? 0) + 1);

        const key = slotKey(entry.dayOfWeek, entry.session, entry.period);
        slotOccupants.set(key, [...(slotOccupants.get(key) ?? []), name]);
    }

    const stats: TimetableStats = {
        totalEntries: entries.length,
        distinctClasses: classCounts.size,
        lowConfidenceEntries: entries.filter((e) => e.confidence === 'low').length,
        oneLessonPerClass:
            entries.length > 0 && entries.length === classCounts.size,
    };

    if (entries.length === 0) {
        issues.push({
            level: 'ERROR',
            code: 'NO_ENTRIES',
            // Chưa chắc có ảnh — bản nháp có thể bắt đầu trống từ một yêu cầu bằng lời.
            message: 'Chưa có buổi dạy nào trong bản nháp',
        });
        return { issues, stats };
    }

    // Một giáo viên không thể dạy hai lớp cùng một khung giờ. Trùng ô gần như
    // luôn là do đọc lệch hàng, không phải do trường xếp lịch sai.
    for (const [key, names] of slotOccupants) {
        if (names.length <= 1) continue;
        const [dayOfWeek, session, period] = key.split('|');
        issues.push({
            level: 'ERROR',
            code: 'SLOT_COLLISION',
            message: `${slotLabel(Number(dayOfWeek), session as DaySession, Number(period))} có ${names.length} lớp cùng lúc (${names.join(', ')}) — nhiều khả năng đọc lệch hàng`,
        });
    }

    const repeated = [...classCounts.entries()].filter(([, count]) => count > 1);
    if (repeated.length > 0) {
        issues.push({
            level: 'WARN',
            code: 'CLASS_REPEATED',
            message: `Có lớp xuất hiện nhiều hơn một lần: ${repeated
                .map(([name, count]) => `${name} (${count} tiết)`)
                .join(', ')}. Đúng nếu môn này dạy nhiều tiết/tuần, sai nếu đọc trùng.`,
        });
    }

    if (stats.oneLessonPerClass) {
        issues.push({
            level: 'INFO',
            code: 'ONE_LESSON_PER_CLASS',
            message: `${stats.totalEntries} tiết cho ${stats.distinctClasses} lớp — mỗi lớp đúng 1 tiết/tuần, lưới khớp`,
        });
    }

    if (stats.lowConfidenceEntries > 0) {
        const uncertain = entries
            .filter((e) => e.confidence === 'low')
            .map(
                (e) =>
                    `${e.className} (${slotLabel(e.dayOfWeek, e.session, e.period)})`,
            );
        issues.push({
            level: 'WARN',
            code: 'LOW_CONFIDENCE',
            message: `Cần soi lại ${uncertain.length} ô đọc chưa chắc: ${uncertain.join(', ')}`,
        });
    }

    // Không có giờ thì không dựng được lịch. Đây là mục chatbot sẽ hỏi lại,
    // nên báo mức ERROR để chặn commit chứ không phải để người dùng sợ.
    const definedTimes = new Set(
        (data.periodTimes ?? []).map((t) => `${t.session}|${t.period}`),
    );
    const missingTimes = new Set<string>();
    for (const entry of entries) {
        const key = `${entry.session}|${entry.period}`;
        if (!definedTimes.has(key)) missingTimes.add(key);
    }
    for (const key of missingTimes) {
        const [session, period] = key.split('|');
        issues.push({
            level: 'ERROR',
            code: 'PERIOD_TIME_MISSING',
            message: `Chưa có khung giờ cho tiết ${period} buổi ${sessionLabel(session as DaySession)}`,
        });
    }

    if (data.notes?.trim()) {
        issues.push({
            level: 'INFO',
            code: 'EXTRACTION_NOTE',
            message: data.notes.trim(),
        });
    }

    return { issues, stats };
}
