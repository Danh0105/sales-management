import { Injectable } from '@nestjs/common';

import { NotificationService } from './notification.service';

import { NotificationType } from '../enums/notification-type.enum';

@Injectable()
export class WeeklyPlanNotificationService {
    constructor(
        private readonly notificationService: NotificationService,
    ) { }

    // ======================================================
    // CREATE
    // ======================================================

    async assignedPlan(data: {
        receiverId: number;

        weeklyPlanId: number;

        senderId?: number;
    }) {
        return this.notificationService.create({
            receiverId: data.receiverId,

            senderId: data.senderId,

            type: NotificationType.WEEKLY_PLAN,

            entityId: data.weeklyPlanId,

            message:
                'Bạn được giao kế hoạch tuần mới',

            meta: {
                weeklyPlanId:
                    data.weeklyPlanId,
            },
        });
    }

    // ======================================================
    // GET ALL
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

            type: NotificationType.WEEKLY_PLAN,
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

            NotificationType.WEEKLY_PLAN,
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

            NotificationType.WEEKLY_PLAN,
        );
    }
}