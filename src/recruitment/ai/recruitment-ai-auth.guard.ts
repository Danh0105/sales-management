import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/** Khoá ngắn hơn thế này coi như chưa cấu hình — chặn khoá yếu kiểu "123". */
export const RECRUITMENT_AI_MIN_KEY_LENGTH = 32;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * So sánh hằng thời gian. Băm trước để hai bên luôn cùng độ dài —
 * `timingSafeEqual` ném lỗi khi khác độ dài, và độ dài key cũng không nên lộ.
 */
export function apiKeyMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Xác thực service-to-service cho OpenClaw: `Authorization: Bearer <key>`.
 * Không dùng JWT của nhân viên — AI không phải một tài khoản HR.
 *
 * - `RECRUITMENT_AI_ENABLED` khác `true` hoặc key chưa cấu hình → 503 (tắt
 *   khẩn mà không phải đổi key).
 * - Sai/thiếu key → 401. Không bao giờ log key, kể cả key sai.
 */
@Injectable()
export class RecruitmentAiAuthGuard implements CanActivate {
  private readonly logger = new Logger(RecruitmentAiAuthGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const enabled =
      this.config.get<string>('RECRUITMENT_AI_ENABLED') === 'true';
    const expected = this.config.get<string>('RECRUITMENT_AI_API_KEY') ?? '';

    if (!enabled || expected.length < RECRUITMENT_AI_MIN_KEY_LENGTH) {
      throw new ServiceUnavailableException({
        code: 'RECRUITMENT_AI_DISABLED',
        message: 'API tuyển dụng cho AI đang tắt hoặc chưa cấu hình',
      });
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header: unknown = req.headers?.authorization;
    const match =
      typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;

    if (!match || !apiKeyMatches(match[1], expected)) {
      this.logger.warn(
        `Từ chối request AI tuyển dụng: ${match ? 'sai API key' : 'thiếu Bearer token'} ` +
          `(${req.method} ${req.originalUrl ?? req.url}, ip=${req.ip})`,
      );
      throw new UnauthorizedException({
        code: 'INVALID_API_KEY',
        message: 'API key không hợp lệ',
      });
    }
    return true;
  }
}
