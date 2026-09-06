/**
 * Thứ trong tuần theo cách gọi tiếng Việt: 2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật.
 * Quy đổi sang Date.getDay() (0 = CN): dayOfWeek 8 -> 0, còn lại giữ nguyên.
 */
export enum DayOfWeek {
    MONDAY = 2,
    TUESDAY = 3,
    WEDNESDAY = 4,
    THURSDAY = 5,
    FRIDAY = 6,
    SATURDAY = 7,
    SUNDAY = 8,
}

export const DAY_OF_WEEK_VALUES = [2, 3, 4, 5, 6, 7, 8];

export const DAY_OF_WEEK_LABELS: Record<number, string> = {
    2: 'Thứ Hai',
    3: 'Thứ Ba',
    4: 'Thứ Tư',
    5: 'Thứ Năm',
    6: 'Thứ Sáu',
    7: 'Thứ Bảy',
    8: 'Chủ Nhật',
};

/** Date.getDay() (0 = CN) -> dayOfWeek nội bộ (8 = CN). */
export function toDayOfWeek(date: Date): number {
    const day = date.getDay();
    return day === 0 ? 8 : day + 1;
}

/**
 * Trạng thái một buổi dạy — vừa là vòng đời buổi học, vừa là kết quả chấm công.
 * Nhân sự là người chốt (SCHEDULED = chưa chấm).
 */
export enum SessionStatus {
    /** Đã lên lịch, chưa chấm công. */
    SCHEDULED = 'SCHEDULED',
    /** Có dạy. */
    PRESENT = 'PRESENT',
    /** Vắng không phép. */
    ABSENT = 'ABSENT',
    /** Nghỉ có phép. */
    EXCUSED = 'EXCUSED',
    /** Huỷ buổi (trường nghỉ, lịch đổi…) — không tính vào công. */
    CANCELLED = 'CANCELLED',
}

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
    [SessionStatus.SCHEDULED]: 'Chưa chấm',
    [SessionStatus.PRESENT]: 'Có dạy',
    [SessionStatus.ABSENT]: 'Vắng',
    [SessionStatus.EXCUSED]: 'Nghỉ có phép',
    [SessionStatus.CANCELLED]: 'Huỷ buổi',
};

/** Các trạng thái được coi là "đã chấm công". */
export const CHECKED_STATUSES = [
    SessionStatus.PRESENT,
    SessionStatus.ABSENT,
    SessionStatus.EXCUSED,
];

/** Buổi bị huỷ không chiếm chỗ của giáo viên nên không tính khi kiểm tra trùng lịch. */
export const ACTIVE_SESSION_STATUSES = [
    SessionStatus.SCHEDULED,
    SessionStatus.PRESENT,
    SessionStatus.ABSENT,
    SessionStatus.EXCUSED,
];

export enum AssignmentStatus {
    OPEN = 'OPEN',
    ASSIGNED = 'ASSIGNED',
    CLOSED = 'CLOSED',
    CANCELLED = 'CANCELLED',
}

export enum TeachingApplicationStatus {
    PENDING = 'PENDING',
    SELECTED = 'SELECTED',
    NOT_SELECTED = 'NOT_SELECTED',
    WITHDRAWN = 'WITHDRAWN',
}

/**
 * Giáo viên phải xác nhận/từ chối lịch (mẫu lặp hoặc buổi lẻ) được giao.
 * Áp dụng trên cả `TeachingSchedule` và `TeachingSession` — buổi sinh ra từ
 * mẫu lặp kế thừa trạng thái của mẫu tại thời điểm sinh.
 */
export enum ConfirmationStatus {
    PENDING = 'PENDING',
    CONFIRMED = 'CONFIRMED',
    REJECTED = 'REJECTED',
}
