import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { RecruitmentZaloWebhookService } from './recruitment-zalo-webhook.service';
import { ZALO_SIGNATURE_HEADER } from './zalo-recruitment-event';

/**
 * Webhook của **Zalo OA tuyển dụng** — tách hẳn khỏi `/zalo/oa/webhook` của OA
 * giáo viên. Không có JWT vì Zalo gọi tới: danh tính dựa vào chữ ký header và
 * OA trong cấu hình server. Cờ `RECRUITMENT_ZALO_ENABLED` khác `true` → 404.
 *
 * Không dùng `@Body()`: chữ ký tính trên body thô (`req.rawBody` do `main.ts`
 * giữ lại), service tự parse sau khi kiểm.
 */
@Controller('recruitment/channels/zalo')
export class RecruitmentZaloWebhookController {
  constructor(private readonly service: RecruitmentZaloWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers(ZALO_SIGNATURE_HEADER) signature?: string,
  ) {
    return this.service.receive(req.rawBody, signature);
  }
}
