import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { LessonMediaArchiveService } from './lesson-media-archive.service';

/**
 * Chỉ nhận những request mà `express.static` ở `main.ts` **không** tìm thấy
 * file trên VPS — tức ảnh đã được chuyển sang NAS, hoặc không tồn tại.
 *
 * File còn trên VPS đi thẳng qua static middleware như trước, không qua đây;
 * đường nóng không thay đổi gì.
 */
@ApiExcludeController()
@Controller('uploads/lesson-images')
export class LessonMediaController {
  constructor(private readonly archive: LessonMediaArchiveService) {}

  @Get('thumb/:name')
  async thumbnail(@Param('name') name: string, @Res() res: Response) {
    // Thumb không bao giờ rời VPS; tới đây nghĩa là thật sự không có.
    const thumb = await this.archive.locateThumbnail(name);
    if (!thumb) return this.notFound(res);
    return res.sendFile(thumb, { maxAge: '7d', immutable: true });
  }

  @Get(':name')
  async media(@Param('name') name: string, @Res() res: Response) {
    const found = await this.archive.locate(name);

    if (found) {
      res.setHeader('X-Lesson-Media-Tier', found.tier);
      // Tên file là UUID, nội dung không bao giờ đổi → cho cache mạnh tay để
      // giảm số lần phải đọc lại từ NAS.
      return res.sendFile(found.path, { maxAge: '30d', immutable: true });
    }

    if (!LessonMediaArchiveService.isValidName(name)) return this.notFound(res);

    // NAS đang ngắt (hoặc file không có ở đó): trả thumbnail thay thế nếu có.
    // Không cache — đây là bản mờ, client phải hỏi lại để lấy bản gốc sau.
    const thumb = await this.archive.locateThumbnail(name);
    if (thumb) {
      res.setHeader('X-Lesson-Media-Tier', 'thumbnail-fallback');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(this.archive.archiveAvailable() ? 404 : 503).sendFile(thumb);
    }

    return this.archive.archiveAvailable()
      ? this.notFound(res)
      : this.unavailable(res);
  }

  private notFound(res: Response) {
    return res.status(404).json({
      statusCode: 404,
      code: 'LESSON_MEDIA_NOT_FOUND',
      message: 'Không tìm thấy ảnh',
    });
  }

  /**
   * NAS mất kết nối và không có thumb. Trả một ảnh SVG thông báo với mã 503:
   * trình duyệt vẫn vẽ được trong thẻ <img>, còn code gọi fetch thì nhìn mã
   * lỗi biết là tạm thời để thử lại.
   */
  private unavailable(res: Response) {
    res.status(503);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '30');
    res.setHeader('X-Lesson-Media-Tier', 'unavailable');
    return res.send(
      `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">` +
        `<rect width="320" height="240" fill="#f1f3f5"/>` +
        `<text x="160" y="112" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#495057">Ảnh đang lưu trữ</text>` +
        `<text x="160" y="136" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#868e96">Kho lưu trữ tạm thời mất kết nối, thử lại sau</text>` +
        `</svg>`,
    );
  }
}
