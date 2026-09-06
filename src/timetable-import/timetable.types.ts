/**
 * Hình dạng dữ liệu **đọc được từ ảnh** — cố ý bám sát những gì in trên tờ thời
 * khoá biểu, không phải payload của API tạo lịch.
 *
 * Model chỉ đọc ảnh; việc tra ID trường/môn/lớp và dựng payload là code. Tách
 * như vậy để một chữ số đọc sai thành một dòng sai nhìn thấy được trong bảng
 * preview, thay vì lặng lẽ thành bản ghi sai trong database.
 */

/** Buổi trong ngày — cột SÁNG / CHIỀU của mỗi thứ. */
export type DaySession = 'SANG' | 'CHIEU';

/** Bảng "THỜI GIAN B. SÁNG" / "B. CHIỀU" thường in kèm phía dưới TKB. */
export interface ExtractedPeriodTime {
    session: DaySession;
    /** Số tiết trong buổi (1, 2, 3, 4…). Giờ ra chơi không phải tiết nên bỏ qua. */
    period: number;
    /** "07:30" */
    startTime: string;
    /** "08:10" */
    endTime: string;
}

/** Một ô có ghi tên lớp trong lưới TKB. */
export interface ExtractedEntry {
    /** 2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật (quy ước tiếng Việt). */
    dayOfWeek: number;
    session: DaySession;
    period: number;
    /** Tên lớp đúng như in trên ảnh: "2/4", "1A", "5/6". */
    className: string;
    /**
     * `low` khi ô mờ, bị loá, hoặc lệch hàng khiến không chắc thuộc tiết nào.
     * Preview tô riêng các ô này để Nhân sự soi lại trước khi xác nhận.
     */
    confidence: 'high' | 'low';
}

/** Thông tin bị thiếu/không đọc được — chatbot sẽ hỏi lại đúng những mục này. */
export type MissingField =
    | 'TEACHER_NAME'
    | 'MORNING_PERIOD_TIMES'
    | 'AFTERNOON_PERIOD_TIMES'
    | 'EFFECTIVE_FROM'
    | 'EFFECTIVE_TO'
    | 'SCHOOL_NAME'
    | 'SUBJECT_NAME'
    | 'SCHOOL_YEAR';

/** Toàn bộ những gì đọc được từ một tấm ảnh TKB. */
export interface ExtractedTimetable {
    schoolName: string | null;
    subjectName: string | null;
    schoolYear: string | null;
    /**
     * Chỉ điền khi ảnh ghi **tên người**. Nhãn chức danh kiểu "GV DẠY GDKNCDS"
     * không phải tên giáo viên — để null và báo thiếu, chatbot sẽ hỏi.
     */
    teacherName: string | null;
    /** "YYYY-MM-DD", suy từ dòng "Áp dụng từ Tuần 10, từ ngày 10/11/2025". */
    effectiveFrom: string | null;
    effectiveTo: string | null;
    periodTimes: ExtractedPeriodTime[];
    entries: ExtractedEntry[];
    missing: MissingField[];
    /** Ghi chú tự do của model về chỗ khó đọc — hiển thị nguyên văn cho Nhân sự. */
    notes: string | null;
}
