/**
 * Thông báo luồng xác nhận/từ chối lịch dạy: yêu cầu xác nhận khi giao lịch,
 * kết quả xác nhận/từ chối, và cảnh báo còn dưới 1 ngày mà chưa phản hồi.
 */

/** Đường dẫn app mở khi giáo viên bấm thông báo — cùng màn lịch dạy hiện có. */
export const TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE = '/giao-vien/lich-day';
export const TEACHING_SCHEDULE_CONFIRM_TEACHER_URL = `/#${TEACHING_SCHEDULE_CONFIRM_TEACHER_ROUTE}`;

/**
 * Đường dẫn quản lý mở khi Giáo vụ/Nhân sự bấm thông báo (kết quả xác nhận,
 * cảnh báo chưa phản hồi). Dùng tạm màn Chấm công — FE chưa có màn riêng cho
 * danh sách "chờ xác nhận"; đổi khi có route mới.
 */
export const TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE = '/nhan-su/cham-cong';
export const TEACHING_SCHEDULE_CONFIRM_MANAGER_URL = `/#${TEACHING_SCHEDULE_CONFIRM_MANAGER_ROUTE}`;

/** Nhãn trong `meta` để FE nhận ra thông báo mà không phải đoán theo nội dung. */
export const TEACHING_SCHEDULE_CONFIRM_REQUEST_KIND = 'TEACHING_SCHEDULE_CONFIRM_REQUEST';
export const TEACHING_SCHEDULE_CONFIRM_RESULT_KIND = 'TEACHING_SCHEDULE_CONFIRM_RESULT';
export const TEACHING_SCHEDULE_CONFIRM_ALERT_KIND = 'TEACHING_SCHEDULE_CONFIRM_ALERT';

export const TEACHING_SCHEDULE_CONFIRM_REQUEST_TITLE = 'Lịch dạy mới cần xác nhận';
export const TEACHING_SCHEDULE_CONFIRM_RESULT_TITLE = 'Kết quả xác nhận lịch dạy';
export const TEACHING_SCHEDULE_CONFIRM_ALERT_TEACHER_TITLE = '⏰ Nhắc xác nhận lịch dạy';
export const TEACHING_SCHEDULE_CONFIRM_ALERT_MANAGER_TITLE = '⏰ Giáo viên chưa xác nhận lịch dạy';

/**
 * Báo trước bao nhiêu phút so với giờ vào dạy thì coi là "sắp tới trong 1 ngày".
 * Mặc định 24h; đổi bằng biến môi trường khi cần siết/nới mà không phải sửa code.
 */
export const TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES = (() => {
    const raw = Number(process.env.TEACHING_SCHEDULE_CONFIRM_ALERT_LEAD_MINUTES);
    return Number.isFinite(raw) && raw > 0 && raw <= 7 * 24 * 60
        ? Math.floor(raw)
        : 24 * 60;
})();
