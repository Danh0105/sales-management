/**
 * Thông báo lịch dạy Nhân sự gửi cho giáo viên.
 *
 * `TEACHING_SCHEDULE_ROUTE` vừa là đường dẫn app mở khi bấm thông báo, vừa là
 * dấu nhận biết các thông báo đã gửi trước khi có type riêng (hồi đó lưu SYSTEM).
 */
export const TEACHING_SCHEDULE_ROUTE = '/giao-vien/lich-day';

/** Đường dẫn dạng hash cho web app. */
export const TEACHING_SCHEDULE_URL = `/#${TEACHING_SCHEDULE_ROUTE}`;

/** Nhãn trong `meta` để FE nhận ra thông báo mà không cần đoán theo nội dung. */
export const TEACHING_SCHEDULE_KIND = 'TEACHING_SCHEDULE';

/** Module nguồn — dùng chung cho meta của notification và data của push. */
export const TEACHING_MODULE = 'teaching';
