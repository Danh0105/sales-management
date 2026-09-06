import {
    Body,
    Controller,
    ForbiddenException,
    Headers,
    HttpCode,
    Logger,
    Post,
    Req,
} from '@nestjs/common';
import type { Request } from 'express';

import { ZaloOaService, type ZaloOaEvent } from './zalo-oa.service';

/**
 * Webhook Zalo OA — nơi nhân viên tự liên kết Zalo để nhận cảnh báo.
 *
 * Luồng: quan tâm OA (hoặc nhắn bất kỳ) -> OA hỏi số điện thoại -> nhân viên
 * nhắn số -> hệ thống khớp với `employee.phone` và lưu `zalo_user_id`.
 *
 * Endpoint **không có JWT** vì Zalo gọi tới, nên danh tính dựa hoàn toàn vào
 * chữ ký trong header. Khai URL này ở Zalo OA console (mục Webhook).
 */
@Controller('zalo/oa')
export class ZaloOaController {
    private readonly logger = new Logger(ZaloOaController.name);

    constructor(private readonly service: ZaloOaService) { }

    @Post('webhook')
    @HttpCode(200)
    async webhook(
        @Body() body: ZaloOaEvent,
        @Req() req: Request & { rawBody?: Buffer },
        @Headers('x-zevent-signature') signature?: string,
    ) {
        // Ký trên đúng chuỗi Zalo gửi; JSON.stringify lại có thể lệch thứ tự key.
        const rawBody = req.rawBody?.toString('utf8') ?? JSON.stringify(body ?? {});

        if (!this.service.verifySignature(rawBody, signature)) {
            throw new ForbiddenException('Chữ ký webhook không hợp lệ');
        }

        const result = await this.service.handleEvent(body ?? {});

        this.logger.log(
            `Zalo OA event=${body?.event_name ?? '?'} -> ${result.action}`,
        );

        // Zalo coi mọi mã khác 200 là gửi hỏng và sẽ thử lại; xử lý xong thì báo ok.
        return { ok: true, ...result };
    }
}
