import { BadRequestException } from '@nestjs/common';
import { toDayOfWeek } from './teaching.enum';

/**
 * "07:30" -> "07:30:00" (dạng Postgres lưu).
 *
 * Tự thêm số 0 đứng đầu cho giờ một chữ số ("7:30" -> "07:30:00"): giờ được so
 * sánh dạng CHUỖI ở `assertTimeOrder` và ở truy vấn trùng giờ, nên thiếu số 0
 * là sai thứ tự — "9:45" bị coi là lớn hơn "14:00" vì ký tự '9' > '1'.
 */
export function toDbTime(value: string): string {
    const matched = value.match(/^(\d{1,2}):([0-5]\d)(:[0-5]\d)?$/);
    if (!matched) return value;

    const hour = matched[1].padStart(2, '0');
    return `${hour}:${matched[2]}${matched[3] ?? ':00'}`;
}

/** "07:30:00" -> "07:30" (dạng FE hiển thị). */
export function toDisplayTime(value: string | null | undefined): string | null {
    if (!value) return null;
    return value.slice(0, 5);
}

/** Date | "2026-08-04T…" -> "2026-08-04" (cột date, không lệch timezone). */
export function toDateString(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value.slice(0, 10);

    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** Cột numeric/nullable từ raw query -> number | null. */
export function nullableNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
}

/**
 * Tiền công của một buổi = đơn giá × số tiết.
 * null khi chưa khai đơn giá — khác hẳn 0 đồng, FE phải hiển thị "chưa khai giá".
 */
export function amountOf(
    ratePerPeriod: number | null | undefined,
    periods: number | null | undefined,
): number | null {
    if (ratePerPeriod === null || ratePerPeriod === undefined) return null;
    return Math.round(ratePerPeriod * (periods ?? 1) * 100) / 100;
}

export function assertTimeOrder(startTime: string, endTime: string): void {
    if (toDbTime(startTime) >= toDbTime(endTime)) {
        throw new BadRequestException('startTime phải nhỏ hơn endTime');
    }
}

export function assertDateOrder(
    from: string | null | undefined,
    to: string | null | undefined,
    message = 'effectiveFrom phải nhỏ hơn hoặc bằng effectiveTo',
): void {
    if (from && to && from > to) {
        throw new BadRequestException(message);
    }
}

/**
 * Liệt kê các ngày trong [from, to] rơi đúng vào thứ chỉ định.
 * Dùng UTC để cộng ngày không bị lệch bởi DST/timezone.
 */
export function listDatesForDayOfWeek(
    from: string,
    to: string,
    dayOfWeek: number,
): string[] {
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);

    while (cursor <= end) {
        // getUTCDay vì cursor được dựng ở UTC.
        const day = cursor.getUTCDay();
        const normalized = day === 0 ? 8 : day + 1;

        if (normalized === dayOfWeek) {
            dates.push(cursor.toISOString().slice(0, 10));
        }

        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return dates;
}

/** Thứ trong tuần của một ngày "YYYY-MM-DD" theo quy ước 2..8. */
export function dayOfWeekOf(date: string): number {
    return toDayOfWeek(new Date(`${date}T00:00:00`));
}

/** "2026-08-04" + 7 -> "2026-08-11". Cộng bằng UTC để không lệch DST/timezone. */
export function addDays(date: string, days: number): string {
    const cursor = new Date(`${date}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() + days);
    return cursor.toISOString().slice(0, 10);
}

/** Hai khoảng thời gian trong ngày có giao nhau không (chạm biên không tính). */
export function timeRangesOverlap(
    aStart: string,
    aEnd: string,
    bStart: string,
    bEnd: string,
): boolean {
    return toDbTime(aStart) < toDbTime(bEnd) && toDbTime(aEnd) > toDbTime(bStart);
}

export interface DayBlockFlags {
    /** Tiết đầu của một chuỗi tiết liên tiếp cùng trường — cần check-in GPS. */
    checkinRequired: boolean;
    /** Tiết cuối của chuỗi — cần check-out GPS. Buổi lẻ thì cả hai đều true. */
    checkoutRequired: boolean;
}

/**
 * Gộp các tiết liên tiếp cùng trường trong ngày của MỘT giáo viên thành từng
 * "block": chỉ tiết đầu block cần check-in, chỉ tiết cuối cần check-out. "Liên
 * tiếp" tính thuần theo thứ tự tiết trong ngày (đầu vào đã sort theo
 * startTime, id) — không xét khoảng nghỉ giữa hai tiết, chỉ cần ĐỊA ĐIỂM giữ
 * nguyên là gộp block; đổi trường **hoặc đổi điểm trường** thì ngắt block.
 *
 * Hàm thuần, không đụng DB, để test độc lập và dùng lại được ở cả nơi tính cờ
 * đọc (`checkinRequired`/`checkoutRequired`) lẫn nơi validate thao tác chấm
 * công.
 */
/**
 * Khoá gộp block = ĐỊA ĐIỂM VẬT LÝ của buổi dạy, không phải trường.
 *
 * Trường nhiều cơ sở: dạy tiết 1 ở "Cơ sở 1" rồi tiết 2 ở "Cơ sở 2" là hai lần
 * đến trường khác nhau — giáo viên phải check-out chỗ cũ và check-in chỗ mới,
 * nên phải ngắt block dù cùng `schoolId`.
 *
 * Tiền tố `L`/`S` là bắt buộc: id điểm trường và id trường đánh số độc lập nên
 * `schoolLocationId ?? schoolId` dạng số sẽ gộp nhầm điểm trường #1 với
 * trường #1.
 */
function blockKeyOf(session: {
    schoolId: number;
    schoolLocationId?: number | null;
}): string {
    return session.schoolLocationId
        ? `L${session.schoolLocationId}`
        : `S${session.schoolId}`;
}

export function computeDayBlocks(
    sessions: Array<{ id: number; schoolId: number; schoolLocationId?: number | null }>,
): Map<number, DayBlockFlags> {
    const result = new Map<number, DayBlockFlags>();

    sessions.forEach((session, index) => {
        const prev = sessions[index - 1];
        const next = sessions[index + 1];
        const key = blockKeyOf(session);
        result.set(session.id, {
            checkinRequired: !prev || blockKeyOf(prev) !== key,
            checkoutRequired: !next || blockKeyOf(next) !== key,
        });
    });

    return result;
}

/** Danh sách ID thuộc đúng block chứa sessionId. */
export function sessionBlockIds(
    sessions: Array<{ id: number; schoolId: number; schoolLocationId?: number | null }>,
    sessionId: number,
): number[] {
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return [];
    const key = blockKeyOf(sessions[index]);
    let start = index;
    let end = index;
    while (start > 0 && blockKeyOf(sessions[start - 1]) === key) start--;
    while (end + 1 < sessions.length && blockKeyOf(sessions[end + 1]) === key) end++;
    return sessions.slice(start, end + 1).map((session) => session.id);
}

/**
 * Buổi này hoặc bất kỳ buổi nào khác cùng block (tiết liên tiếp cùng trường,
 * đã sort theo startTime/id) đã có check-in chưa — dùng để nới lỏng điều kiện
 * "phải tự check-in mới được check-out/nộp bài" cho tiết giữa/cuối block.
 */
export function isBlockCheckedIn(
    sessions: Array<{
        id: number;
        schoolId: number;
        schoolLocationId?: number | null;
        checkinAt: Date | null;
    }>,
    sessionId: number,
): boolean {
    const index = sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) return false;

    const key = blockKeyOf(sessions[index]);

    for (let i = index; i >= 0 && blockKeyOf(sessions[i]) === key; i--) {
        if (sessions[i].checkinAt) return true;
    }
    for (
        let j = index + 1;
        j < sessions.length && blockKeyOf(sessions[j]) === key;
        j++
    ) {
        if (sessions[j].checkinAt) return true;
    }

    return false;
}
