/**
 * Chỉ đúng ở process production (`sales-management`, port 3010).
 *
 * `sales-be` (dev, port 3011) và `sales-management` (prod) chạy cùng
 * `dist/` và chung `sales_db` — mỗi process tự đăng ký lịch `@Cron` độc
 * lập, không có khoá phân tán nào giữa chúng. Nếu để cron chạy ở cả 2 nơi,
 * mọi báo động/nhắc nhở tự động sẽ bị gửi trùng cho người dùng thật mỗi
 * lần đến giờ (đã xác nhận qua dữ liệu thật: nhắc quá hạn đề xuất chi lặp
 * lại 08:00 mỗi ngày do cả 2 process cùng chạy).
 *
 * Gọi ở đầu MỖI method `@Cron(...)` — không gọi trong hàm logic bên trong
 * (`runXxx()`), vì các hàm đó còn được gọi thủ công qua API test/trigger
 * ngay cả từ môi trường dev.
 */
export const isCronLeader = () => process.env.NODE_ENV === 'production';
