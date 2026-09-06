import { Injectable } from '@nestjs/common';

import { NotificationService } from './notification.service';

import { NotificationType } from '../enums/notification-type.enum';

import { FcmService } from '../../fcm/fcm.service';

@Injectable()
export class SuggestNotificationService {
    constructor(
        private readonly notificationService: NotificationService,
        private readonly fcmService: FcmService,
    ) { }

    // ======================================================
    // CREATE
    // ======================================================

    async create(data: {
        receiverId: number;

        suggestId: number;

        senderId?: number;

        message?: string;
    }) {
        return this.notificationService.create({
            receiverId: data.receiverId,

            senderId: data.senderId,

            type: NotificationType.SUGGEST,

            entityId: data.suggestId,

            message:
                data.message ??
                'Bạn có đề xuất mới',

            meta: {
                suggestId: data.suggestId,
            },
        });
    }

    // ======================================================
    // FIND ALL
    // ======================================================

    async findAll(data: {
        receiverId: number;

        page?: number;

        limit?: number;

        tab?: 'unread' | 'read';
    }) {
        return this.notificationService.findAllWithPagination({
            receiverId: data.receiverId,

            page: data.page,

            limit: data.limit,

            tab: data.tab,

            type: NotificationType.SUGGEST,
        });
    }

    // ======================================================
    // COUNT UNREAD
    // ======================================================

    async countUnread(
        receiverId: number,
    ) {
        return this.notificationService.countUnreadByType(
            receiverId,

            NotificationType.SUGGEST,
        );
    }

    // ======================================================
    // MARK AS READ
    // ======================================================

    async markAsRead(
        id: number,
        receiverId: number,
    ) {
        return this.notificationService.markAsRead(
            id,
            receiverId,
        );
    }

    // ======================================================
    // MARK ALL AS READ
    // ======================================================

    async markAllAsRead(
        receiverId: number,
    ) {
        return this.notificationService.markAllAsReadByType(
            receiverId,

            NotificationType.SUGGEST,
        );
    }
    async handleSuggestCreated(event: any) {
        return this.notifyAndPush({
            receiverIds: event.receiverIds ?? [],
            tokens: event.tokens ?? [],
            senderId: event.senderId,
            suggestId: event.suggestId,
            message: event.message ?? 'Bạn có đề xuất mới',
            pushTitle: '📄 Có đề xuất mới',
        });
    }

    // ======================================================
    // SUGGEST REVIEWED
    // ======================================================

    async handleSuggestReviewed(event: any) {
        return this.notifyAndPush({
            receiverIds: event.receiverIds ?? [],
            tokens: event.tokens ?? [],
            senderId: event.reviewerId,
            suggestId: event.suggestId,
            message: event.message ?? 'Đề xuất của bạn đã được xem xét',
            pushTitle: '📄 Đề xuất đã được xem xét',
        });
    }

    // ======================================================
    // SUGGEST APPROVED
    // ======================================================

    async handleSuggestApproved(event: any) {
        const data = event.data ?? event;
        return this.notifyAndPush({
            receiverIds: data.receiverIds ?? [],
            tokens: data.tokens ?? [],
            senderId: data.actorId,
            suggestId: data.suggestId,
            message: data.message ?? 'Đề xuất của bạn đã được phê duyệt',
            pushTitle: '📄 Đề xuất đã được duyệt',
        });
    }

    // ======================================================
    // Tạo 1 bản ghi thông báo cho MỖI người nhận + đẩy push tới
    // MỌI thiết bị (không chỉ 1 token/người) — dùng chung cho cả 3 sự kiện trên.
    // ======================================================

    private async notifyAndPush(input: {
        receiverIds: number[];
        tokens: string[];
        senderId?: number;
        suggestId: number;
        message: string;
        pushTitle: string;
    }) {
        const { receiverIds, tokens, senderId, suggestId, message, pushTitle } = input;

        if (receiverIds.length > 0) {
            await this.notificationService.createNotifications({
                receiverIds,
                senderId,
                type: NotificationType.SUGGEST,
                entityId: suggestId,
                message,
                meta: { suggestId },
            });
        }

        if (tokens.length > 0) {
            await this.fcmService.sendToMultiple(tokens, pushTitle, message, {
                kind: 'suggest',
                suggestId: String(suggestId),
            });
        }
    }
}