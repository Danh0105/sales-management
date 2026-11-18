import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import {
    describeHttpError,
    ZaloTokenError,
    ZaloTokenService,
} from '../zalo-token/zalo-token.service';

/**
 * Zalo báo lỗi nghiệp vụ (chưa quan tâm OA, quá hạn tương tác, OA thiếu gói…)
 * bằng HTTP 200 + `error` khác 0 — không bắt riêng thì tin hỏng vẫn bị tính là đã gửi.
 */
export class ZaloSendRejectedError extends Error {
    constructor(
        readonly code: number,
        detail: string,
    ) {
        super(`Zalo từ chối, mã ${code}${detail ? `: ${detail}` : ''}`);
        this.name = 'ZaloSendRejectedError';
    }
}

@Injectable()
export class NotifyService {
    private readonly logger = new Logger(NotifyService.name);
    private readonly ZALO_API = 'https://openapi.zalo.me/v3.0/oa/message/cs';

    constructor(private zaloTokenService: ZaloTokenService) { }

    /**
     * Gửi cùng một nội dung cho nhiều người, hỏng người nào bỏ qua người đó.
     *
     * Dùng cho báo động: Zalo là kênh phụ, một người chưa follow OA hoặc token
     * hết hạn thì không được phép làm hỏng cả lượt báo động của những người còn lại.
     * Trả về số gửi được để nơi gọi ghi log.
     */
    async sendToMany(
        userIds: string[],
        message: string,
    ): Promise<{ sent: number; failed: number }> {
        const targets = [...new Set(userIds.filter(Boolean))];
        if (!targets.length) return { sent: 0, failed: 0 };

        const results = await Promise.allSettled(
            targets.map((userId) => this.sendMessage(userId, message)),
        );

        const failed = results.filter((r) => r.status === 'rejected').length;

        if (failed) {
            this.logger.warn(
                `Zalo: gửi được ${results.length - failed}/${results.length} tin`,
            );
        }

        return { sent: results.length - failed, failed };
    }
    async sendMessage(userId: string, message: string) {
        try {
            const token = await this.zaloTokenService.getValidToken();

            const res = await axios.post(
                this.ZALO_API,
                {
                    recipient: { user_id: userId },
                    message: { text: message },
                },
                {
                    headers: {
                        access_token: token,
                    },
                },
            );

            const code = Number(res.data?.error ?? 0);
            if (code !== 0) {
                throw new ZaloSendRejectedError(
                    code,
                    String(res.data?.message ?? '').slice(0, 200),
                );
            }

            // Không log response (id người nhận) — và tuyệt đối không log token.
            return res.data;
        } catch (error) {
            // Lỗi axios mang `config.headers.access_token` — chỉ giữ mã, ném lỗi đã làm sạch.
            const reason =
                error instanceof ZaloTokenError ||
                error instanceof ZaloSendRejectedError
                    ? error.message
                    : describeHttpError(error);
            this.logger.warn(`Zalo send error: ${reason}`);
            throw new ZaloTokenError(`Gửi tin Zalo OA thất bại (${reason})`);
        }
    }
}