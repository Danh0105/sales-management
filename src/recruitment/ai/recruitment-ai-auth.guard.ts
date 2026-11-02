import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';

import {
  parseRecruitmentSubject,
  RECRUITMENT_SUBJECT_HEADER,
  type RecruitmentAiCredential,
  type RecruitmentAiRequest,
} from './recruitment-ai-subject';

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
 * Hai loại key:
 * - `RECRUITMENT_AI_API_KEY` — key AI chung (harness/staging Phase 2), **không**
 *   được mang subject.
 * - `RECRUITMENT_CHANNEL_API_KEY` — key của kênh tin cậy (plugin chạy trong session
 *   do adapter Zalo tạo), **bắt buộc** mang `X-Recruitment-Subject` hợp lệ.
 *
 * - `RECRUITMENT_AI_ENABLED` khác `true` hoặc không có key nào → 503 (tắt khẩn
 *   mà không phải đổi key). Hai key trùng nhau → 503 (cấu hình sai).
 * - Sai/thiếu key → 401. Không bao giờ log key, kể cả key sai.
 * - `RECRUITMENT_AI_REQUIRE_SUBJECT=true` → chỉ key kênh được dùng.
 */
@Injectable()
export class RecruitmentAiAuthGuard implements CanActivate {
  private readonly logger = new Logger(RecruitmentAiAuthGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const enabled =
      this.config.get<string>('RECRUITMENT_AI_ENABLED') === 'true';
    const aiKey = configuredKey(
      this.config.get<string>('RECRUITMENT_AI_API_KEY'),
    );
    const channelKey = configuredKey(
      this.config.get<string>('RECRUITMENT_CHANNEL_API_KEY'),
    );
    const requireSubject =
      this.config.get<string>('RECRUITMENT_AI_REQUIRE_SUBJECT') === 'true';

    if (!enabled || (!aiKey && !channelKey)) {
      throw new ServiceUnavailableException({
        code: 'RECRUITMENT_AI_DISABLED',
        message: 'API tuyển dụng cho AI đang tắt hoặc chưa cấu hình',
      });
    }
    if (aiKey && channelKey && apiKeyMatches(aiKey, channelKey)) {
      this.logger.error(
        'RECRUITMENT_CHANNEL_API_KEY trùng RECRUITMENT_AI_API_KEY — từ chối mọi request AI',
      );
      throw new ServiceUnavailableException({
        code: 'RECRUITMENT_AI_MISCONFIGURED',
        message: 'API tuyển dụng cho AI cấu hình sai',
      });
    }

    const req = context.switchToHttp().getRequest<RecruitmentAiRequest>();
    const header: unknown = req.headers?.authorization;
    const match =
      typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    const credential: RecruitmentAiCredential | null = !match
      ? null
      : channelKey && apiKeyMatches(match[1], channelKey)
        ? 'channel'
        : aiKey && apiKeyMatches(match[1], aiKey)
          ? 'ai'
          : null;

    if (!credential) {
      this.logger.warn(
        `Từ chối request AI tuyển dụng: ${match ? 'sai API key' : 'thiếu Bearer token'} ` +
          `(${req.method} ${req.originalUrl ?? req.url}, ip=${req.ip})`,
      );
      throw new UnauthorizedException({
        code: 'INVALID_API_KEY',
        message: 'API key không hợp lệ',
      });
    }

    const rawSubject: unknown = req.headers?.[RECRUITMENT_SUBJECT_HEADER];
    const hasSubject = rawSubject !== undefined && rawSubject !== '';

    if (credential === 'ai') {
      if (hasSubject) {
        this.deny(
          req,
          'SUBJECT_NOT_TRUSTED',
          'key AI chung không được mang subject',
        );
      }
      if (requireSubject) {
        this.deny(req, 'SUBJECT_REQUIRED', 'chỉ nhận request từ kênh tin cậy');
      }
      req.recruitmentAi = { credential, subject: null };
      return true;
    }

    if (!hasSubject) {
      this.deny(req, 'SUBJECT_REQUIRED', 'key kênh phải kèm subject');
    }
    const subject = parseRecruitmentSubject(rawSubject);
    if (!subject) {
      this.deny(req, 'SUBJECT_INVALID', 'subject sai định dạng');
    }
    req.recruitmentAi = { credential, subject };
    return true;
  }

  private deny(req: RecruitmentAiRequest, code: string, reason: string): never {
    this.logger.warn(
      `Từ chối request AI tuyển dụng: ${reason} (${req.method} ${req.originalUrl ?? req.url})`,
    );
    throw new ForbiddenException({
      code,
      message: 'Request không có danh tính kênh hợp lệ',
    });
  }
}

/** Key ngắn hơn ngưỡng coi như chưa cấu hình — chặn khoá yếu kiểu "123". */
function configuredKey(value: string | undefined): string | null {
  return value && value.length >= RECRUITMENT_AI_MIN_KEY_LENGTH ? value : null;
}
