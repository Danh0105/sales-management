/**
 * Prompt mặc định cho thử đồ ảo.
 *
 * Viết theo lối "giữ nguyên X, chỉ thay Y" vì mô hình sinh ảnh có xu hướng vẽ
 * lại cả khuôn mặt/dáng người nếu không chặn — mà đó chính là thứ khách muốn
 * giữ nguyên khi thử đồ. Ảnh thứ nhất luôn là người, ảnh thứ hai là trang phục
 * (`VirtualTryOnOpenAiService` gửi đúng thứ tự này).
 */
export const DEFAULT_TRYON_PROMPT =
  'Ảnh 1 là người mặc, ảnh 2 là món trang phục. Hãy tạo ảnh người ở ảnh 1 đang ' +
  'mặc món đồ ở ảnh 2. Giữ nguyên khuôn mặt, kiểu tóc, dáng người, tư thế, ' +
  'ánh sáng và bối cảnh của ảnh 1. Trang phục phải đúng kiểu dáng, màu sắc, ' +
  'hoa văn và chất liệu như ảnh 2, ôm theo dáng người một cách tự nhiên, có ' +
  'nếp gấp và đổ bóng hợp lý. Không thêm chữ, logo hay watermark.';

/** Model mặc định; đổi bằng `VIRTUAL_TRYON_MODEL` trong .env khi có model mới. */
export const DEFAULT_TRYON_MODEL = 'gpt-image-2';

export const TRYON_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
export type TryOnSize = (typeof TRYON_SIZES)[number];

/** Ảnh người thường là ảnh dọc nên mặc định lấy khổ dọc. */
export const DEFAULT_TRYON_SIZE: TryOnSize = '1024x1536';

export const TRYON_SUPPORTED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

/**
 * Trần dung lượng mỗi ảnh tải lên. Ảnh điện thoại hiện nay ~5–10MB nên 15MB đủ
 * rộng; ảnh vẫn được nén lại trước khi gửi cho mô hình.
 */
export const TRYON_MAX_FILE_BYTES = 15 * 1024 * 1024;

/**
 * Cạnh dài tối đa trước khi gửi lên mô hình. Mô hình tự co ảnh về khổ của nó,
 * gửi ảnh 4000px chỉ tốn băng thông và thời gian chứ không thêm chi tiết.
 */
export const TRYON_MAX_IMAGE_EDGE = 1536;
