import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { NotifyService } from '../notify-zalo/notify.service';
import { extractVietnamPhone, isUnlinkCommand } from './zalo-phone';

/** Sự kiện Zalo OA gửi về (chỉ khai các field mình dùng). */
export interface ZaloOaEvent {
    app_id?: string;
    event_name?: string;
    timestamp?: string | number;
    sender?: { id?: string };
    follower?: { id?: string };
    message?: { text?: string; msg_id?: string };
}

export type ZaloOaResult =
    | { action: 'ignored'; reason: string }
    | { action: 'linked'; employeeId: number }
    | { action: 'unlinked'; employeeId?: number }
    | { action: 'not_found'; phone: string }
    | { action: 'prompted' };

const REPLY = {
    linked: (name: string) =>
        `✅ Đã liên kết Zalo với tài khoản ${name}.\n` +
        'Từ giờ bạn sẽ nhận cảnh báo giáo viên chưa check-in tại đây.\n' +
        'Nhắn "HUY" nếu muốn ngừng nhận.',
    notFound:
        '❌ Không tìm thấy nhân viên nào dùng số này.\n' +
        'Kiểm tra lại số đã khai trong hồ sơ nhân sự, hoặc nhờ phòng Nhân sự cập nhật giúp.',
    prompt:
        'Chào bạn 👋\n' +
        'Nhắn **số điện thoại** đã đăng ký với công ty để nhận cảnh báo giáo viên chưa check-in qua Zalo.',
    unlinked: '🔕 Đã ngừng gửi cảnh báo qua Zalo. Nhắn lại số điện thoại khi cần bật lại.',
};

@Injectable()
export class ZaloOaService {
    private readonly logger = new Logger(ZaloOaService.name);

    constructor(
        @InjectRepository(Employee)
        private readonly employeeRepo: Repository<Employee>,

        private readonly notifyService: NotifyService,
    ) { }

    /**
     * Kiểm tra chữ ký của webhook.
     *
     * Zalo ký bằng SHA256(appId + rawBody + timestamp + OASecretKey) và đặt ở
     * header `X-ZEvent-Signature` dạng `mac=<hash>`.
     *
     * Chưa khai secret thì **từ chối** thay vì cho qua: endpoint này ghi thẳng
     * vào hồ sơ nhân viên, để mở là ai cũng gọi được và tự gán Zalo của mình vào
     * tài khoản người khác. Muốn tắt kiểm tra lúc đang dò cấu hình thì đặt
     * `ZALO_OA_WEBHOOK_VERIFY=0`.
     */
    verifySignature(rawBody: string, signature?: string): boolean {
        if (process.env.ZALO_OA_WEBHOOK_VERIFY === '0') {
            this.logger.warn(
                'Webhook Zalo OA đang TẮT kiểm tra chữ ký — chỉ dùng khi đang dò cấu hình',
            );
            return true;
        }

        const secret =
            process.env.ZALO_OA_SECRET_KEY || process.env.ZALO_APP_SECRET;

        if (!secret) {
            this.logger.error(
                'Thiếu ZALO_OA_SECRET_KEY — từ chối webhook để không ai gán bừa Zalo vào tài khoản người khác',
            );
            return false;
        }

        if (!signature) return false;

        const received = signature.replace(/^mac=/, '').trim().toLowerCase();

        let payload: ZaloOaEvent = {};
        try {
            payload = JSON.parse(rawBody);
        } catch {
            return false;
        }

        const expected = createHash('sha256')
            .update(
                `${payload.app_id ?? ''}${rawBody}${payload.timestamp ?? ''}${secret}`,
            )
            .digest('hex');

        if (expected !== received) {
            // In cả hai để đối chiếu khi Zalo đổi công thức ký — không lộ secret.
            this.logger.warn(
                `Chữ ký webhook Zalo không khớp (nhận ${received.slice(0, 12)}…, tính ${expected.slice(0, 12)}…)`,
            );
            return false;
        }

        return true;
    }

    async handleEvent(event: ZaloOaEvent): Promise<ZaloOaResult> {
        const name = event.event_name ?? '';

        switch (name) {
            case 'user_send_text':
                return this.handleText(event);

            case 'follow':
                return this.handleFollow(event);

            case 'unfollow':
                return this.handleUnfollow(event);

            default:
                // Ảnh, sticker, tin gửi đi… không liên quan tới việc liên kết.
                return { action: 'ignored', reason: name || 'không rõ sự kiện' };
        }
    }

    private async handleText(event: ZaloOaEvent): Promise<ZaloOaResult> {
        const zaloUserId = event.sender?.id;
        const text = event.message?.text ?? '';

        if (!zaloUserId) return { action: 'ignored', reason: 'thiếu sender.id' };

        if (isUnlinkCommand(text)) {
            return this.unlink(zaloUserId);
        }

        const phone = extractVietnamPhone(text);
        if (!phone) {
            await this.reply(zaloUserId, REPLY.prompt);
            return { action: 'prompted' };
        }

        const employee = await this.employeeRepo.findOne({
            where: { phone, isActive: true },
        });

        if (!employee?.id) {
            await this.reply(zaloUserId, REPLY.notFound);
            return { action: 'not_found', phone };
        }

        // Một Zalo chỉ trỏ về một người: gỡ liên kết cũ trước khi gán mới, tránh
        // hai hồ sơ cùng nhận chung một hộp thoại.
        await this.employeeRepo.update({ zaloUserId }, { zaloUserId: null });
        await this.employeeRepo.update(employee.id, { zaloUserId });

        this.logger.log(
            `Zalo OA: liên kết ${zaloUserId} -> nhân viên #${employee.id} (${employee.name})`,
        );

        await this.reply(zaloUserId, REPLY.linked(employee.name ?? 'của bạn'));

        return { action: 'linked', employeeId: employee.id };
    }

    private async handleFollow(event: ZaloOaEvent): Promise<ZaloOaResult> {
        const zaloUserId = event.follower?.id ?? event.sender?.id;
        if (!zaloUserId) return { action: 'ignored', reason: 'thiếu follower.id' };

        await this.reply(zaloUserId, REPLY.prompt);
        return { action: 'prompted' };
    }

    private async handleUnfollow(event: ZaloOaEvent): Promise<ZaloOaResult> {
        const zaloUserId = event.follower?.id ?? event.sender?.id;
        if (!zaloUserId) return { action: 'ignored', reason: 'thiếu follower.id' };

        // Bỏ quan tâm OA thì tin nhắn không tới được nữa; xoá luôn cho sạch.
        return this.unlink(zaloUserId, false);
    }

    private async unlink(
        zaloUserId: string,
        notify = true,
    ): Promise<ZaloOaResult> {
        const employee = await this.employeeRepo.findOne({
            where: { zaloUserId },
        });

        if (!employee?.id) {
            if (notify) await this.reply(zaloUserId, REPLY.unlinked);
            return { action: 'unlinked' };
        }

        await this.employeeRepo.update(employee.id, { zaloUserId: null });
        this.logger.log(
            `Zalo OA: gỡ liên kết nhân viên #${employee.id} (${employee.name})`,
        );

        if (notify) await this.reply(zaloUserId, REPLY.unlinked);

        return { action: 'unlinked', employeeId: employee.id };
    }

    /** Trả lời trong hộp thoại OA; hỏng thì bỏ qua, không làm hỏng webhook. */
    private async reply(zaloUserId: string, message: string): Promise<void> {
        try {
            await this.notifyService.sendMessage(zaloUserId, message);
        } catch (error) {
            this.logger.warn(
                `Không trả lời được ${zaloUserId}: ${(error as Error).message}`,
            );
        }
    }
}
