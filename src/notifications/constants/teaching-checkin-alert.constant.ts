/**
 * Báo động "sắp tới giờ dạy mà giáo viên chưa check-in".
 *
 * Người nhận là Giáo vụ và Nhân sự (không phải giáo viên) nên đường dẫn trỏ về
 * màn Chấm công của khối quản lý — nơi họ nhìn thấy cả buổi dạy lẫn nút xử lý.
 */
export const TEACHING_CHECKIN_ALERT_ROUTE = '/nhan-su/cham-cong';

/** Đường dẫn dạng hash cho web app. */
export const TEACHING_CHECKIN_ALERT_URL = `/#${TEACHING_CHECKIN_ALERT_ROUTE}`;

/** Nhãn trong `meta` để FE nhận ra báo động mà không phải đoán theo nội dung. */
export const TEACHING_CHECKIN_ALERT_KIND = 'TEACHING_CHECKIN_ALERT';

/** Tiêu đề push — cố định để người nhận nhận ra ngay trên màn hình khoá. */
export const TEACHING_CHECKIN_ALERT_TITLE = '🚨 Giáo viên chưa check-in';

/**
 * Báo trước bao nhiêu phút so với giờ vào dạy. Đổi bằng biến môi trường
 * `TEACHING_CHECKIN_ALERT_LEAD_MINUTES` khi trường muốn siết/nới, không phải sửa code.
 */
export const TEACHING_CHECKIN_ALERT_LEAD_MINUTES = (() => {
    const raw = Number(process.env.TEACHING_CHECKIN_ALERT_LEAD_MINUTES);
    return Number.isFinite(raw) && raw > 0 && raw <= 120 ? Math.floor(raw) : 5;
})();

/**
 * Banner quản lý chỉ giữ buổi trễ trong khoảng này. Sau mốc này cảnh báo tự
 * biến mất để các buổi cũ không nằm trên màn hình suốt phần còn lại của ngày.
 */
export const TEACHING_CHECKIN_ALERT_LATE_MINUTES = (() => {
    const raw = Number(process.env.TEACHING_CHECKIN_ALERT_LATE_MINUTES);
    return Number.isFinite(raw) && raw > 0 && raw <= 120 ? Math.floor(raw) : 10;
})();

/**
 * Có gửi báo động qua Zalo OA không. Mặc định **tắt**: tin OA chỉ tới được người
 * đã quan tâm OA và đã có `zalo_user_id`, bật sẵn mà chưa gán ID thì mỗi phút
 * lại ghi một dòng cảnh báo vô ích trong log.
 *
 * Bật bằng `TEACHING_CHECKIN_ALERT_ZALO=1` trong .env.
 */
/**
 * Đọc tại thời điểm job chạy vì ConfigModule nạp `.env` sau lúc các module
 * TypeScript được import. Nếu chốt thành hằng số ở đây, giá trị trong `.env`
 * có thể luôn bị hiểu là tắt khi khởi động ứng dụng bình thường.
 */
export const isTeachingCheckinAlertZaloEnabled = () =>
    process.env.TEACHING_CHECKIN_ALERT_ZALO === '1';

/** Tiền tố cho tin Zalo — trong hộp thoại OA không có tiêu đề riêng như push. */
export const TEACHING_CHECKIN_ALERT_ZALO_PREFIX = '🚨 CHƯA CHECK-IN\n';
