import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Chặn lạm dụng cho endpoint tạo ảnh — mỗi lượt gọi tốn tiền thật vào tài
 * khoản OpenAI, mà endpoint này mở công khai (không cần đăng nhập).
 *
 * Cố ý làm bộ đếm trong RAM thay vì thêm Redis/thư viện: chỉ có một tiến trình
 * production phục vụ (xem `is-cron-leader.ts`), và đây là **rào chi phí** chứ
 * không phải rào bảo mật — mất bộ đếm khi restart là chấp nhận được. Nếu sau
 * này chạy nhiều tiến trình thì phải chuyển sang bộ đếm dùng chung.
 */
@Injectable()
export class VirtualTryOnRateLimitService {
  private readonly logger = new Logger(VirtualTryOnRateLimitService.name);

  /** IP → mốc thời gian các lượt gọi còn trong cửa sổ. */
  private readonly hits = new Map<string, number[]>();

  /** Dọn định kỳ để Map không phình theo số IP đã từng gọi. */
  private lastSweep = Date.now();

  constructor(private readonly config: ConfigService) {}

  private get windowMs(): number {
    const hours = Number(this.config.get('VIRTUAL_TRYON_RATE_WINDOW_HOURS'));
    return (Number.isFinite(hours) && hours > 0 ? hours : 1) * 60 * 60 * 1000;
  }

  private get maxPerWindow(): number {
    const max = Number(this.config.get('VIRTUAL_TRYON_RATE_MAX'));
    return Number.isFinite(max) && max > 0 ? Math.floor(max) : 5;
  }

  /**
   * Lấy IP thật của khách. Nginx đặt `X-Forwarded-For`, lấy phần tử ĐẦU (client
   * gốc); các phần sau là proxy trung gian.
   */
  clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(',')[0]?.trim();
    return first || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Ghi nhận một lượt gọi; vượt hạn mức thì ném 429 kèm số giây phải chờ.
   * Người đã đăng nhập được miễn — họ đã định danh, và đây là nhân viên nội bộ.
   */
  consume(req: Request, isAuthenticated: boolean): void {
    if (isAuthenticated) return;

    const now = Date.now();
    this.sweep(now);

    const ip = this.clientIp(req);
    const windowMs = this.windowMs;
    const recent = (this.hits.get(ip) ?? []).filter(
      (at) => now - at < windowMs,
    );

    if (recent.length >= this.maxPerWindow) {
      const retryAfterSec = Math.ceil(
        (windowMs - (now - recent[0])) / 1000,
      );
      this.logger.warn(`Chặn quá hạn mức thử đồ ảo từ IP ${ip}`);

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'TRYON_RATE_LIMITED_IP',
          message:
            `Bạn đã tạo ${this.maxPerWindow} ảnh trong khoảng thời gian ngắn. ` +
            `Vui lòng thử lại sau ${Math.ceil(retryAfterSec / 60)} phút.`,
          retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.hits.set(ip, recent);
  }

  /** Trả lại lượt đã trừ khi việc tạo job hỏng — lỗi của hệ thống, không tính cho khách. */
  refund(req: Request, isAuthenticated: boolean): void {
    if (isAuthenticated) return;
    const ip = this.clientIp(req);
    const recent = this.hits.get(ip);
    if (recent?.length) recent.pop();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;

    for (const [ip, times] of this.hits) {
      const kept = times.filter((at) => now - at < this.windowMs);
      if (kept.length) this.hits.set(ip, kept);
      else this.hits.delete(ip);
    }
  }
}
