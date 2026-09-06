/**
 * Vòng đời một lần thử đồ ảo. Sinh ảnh mất 10–60s nên API chạy bất đồng bộ:
 * tạo job trả về ngay, client hỏi lại trạng thái cho tới khi xong.
 */
export enum TryOnJobStatus {
  /** Đã nhận ảnh, chờ tới lượt gọi mô hình. */
  PENDING = 'PENDING',
  /** Đang gọi mô hình sinh ảnh. */
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

/** Trạng thái đã kết thúc — client ngừng hỏi lại khi thấy các giá trị này. */
export const TRYON_TERMINAL_STATUSES = [
  TryOnJobStatus.SUCCEEDED,
  TryOnJobStatus.FAILED,
];
