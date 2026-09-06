/**
 * Thông báo giáo viên từ chối buổi đã được phân công (việc đột xuất) — báo
 * cho Giáo vụ/Nhân sự để chọn người thay thế.
 */

/** Nhãn trong `meta` để FE nhận ra thông báo mà không phải đoán theo nội dung. */
export const TEACHING_SESSION_DECLINE_KIND = 'TEACHING_REPLACEMENT_REQUEST';

/** Màn Nhân sự/Giáo vụ mở khi bấm thông báo — tab buổi dạy, đúng buổi vừa bị từ chối. */
export const TEACHING_SESSION_DECLINE_ROUTE = '/nhan-su/lich-day';
export const TEACHING_SESSION_DECLINE_URL = `/#${TEACHING_SESSION_DECLINE_ROUTE}`;

export const TEACHING_SESSION_DECLINE_TITLE = '⚠️ Giáo viên từ chối buổi dạy';
