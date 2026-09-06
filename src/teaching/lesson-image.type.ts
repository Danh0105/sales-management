/**
 * Ảnh bài dạy lưu kèm buổi check-out.
 *
 * Kiểu dùng chung cho entity, storage service và response nên để riêng file:
 * `data-source.ts` nạp entity, không kéo theo `sharp` của storage service.
 */
export interface LessonImage {
  /** Định danh ổn định của ảnh — UUID trùng tên file, không có phần mở rộng. */
  id: string;

  url: string;

  /** Tên file trên đĩa. */
  name: string;

  mimeType: string;

  /** Dung lượng sau khi chuyển WebP (byte); null với ảnh lưu trước bản này. */
  size: number | null;

  /** Thứ tự người dùng gửi lên, bắt đầu từ 0. */
  sortOrder: number;
}

/**
 * Ảnh đọc từ cột `lesson_images`. Bản ghi tạo trước khi có metadata chỉ có
 * `url` + `name`, nên mọi trường khác đều là tuỳ chọn khi đọc.
 */
export type StoredLessonImage = Partial<LessonImage> & { url: string };

/** Contract ảnh tối giản trả cho frontend trong TeachingSession. */
export interface LessonImageResponse {
  id: number;
  url: string;
  mimeType?: string;
  mediaType?: 'image' | 'video';
}
