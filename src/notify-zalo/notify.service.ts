import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ZaloTokenService } from '../zalo-token/zalo-token.service';

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

            console.log("Zalo response:", res.data);

            return res.data;
        } catch (error) {
            console.error(
                'Zalo send error:',
                error?.response?.data || error.message,
            );
            throw error;
        }
    }
}