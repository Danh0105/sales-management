import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

export const DEFAULT_RECRUITMENT_AI_RATE_LIMIT = 300;
const WINDOW_MS = 60_000;

/**
 * Giới hạn số request/phút cho toàn bộ API AI.
 *
 * Đếm trong bộ nhớ, cửa sổ cố định 1 phút. Đủ cho Phase 1 vì pm2 chạy fork
 * mode, mỗi port một process, và chỉ OpenClaw gọi (một key). Chạy cluster
 * thì mỗi process đếm riêng — khi đó chuyển sang đếm trong Redis/DB.
 *
 * Chạy **sau** guard xác thực, nên request sai key không ăn vào hạn mức.
 */
@Injectable()
export class RecruitmentAiRateLimitGuard implements CanActivate {
  private windowStart = 0;
  private count = 0;

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const limit = this.limit();
    const now = Date.now();
    if (now - this.windowStart >= WINDOW_MS) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;

    if (this.count > limit) {
      const retryAfter = Math.ceil((this.windowStart + WINDOW_MS - now) / 1000);
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: `Vượt giới hạn ${limit} request/phút — thử lại sau ${retryAfter}s`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private limit(): number {
    const raw = Number(
      this.config.get<string>('RECRUITMENT_AI_RATE_LIMIT_PER_MINUTE'),
    );
    return Number.isInteger(raw) && raw > 0
      ? raw
      : DEFAULT_RECRUITMENT_AI_RATE_LIMIT;
  }
}
