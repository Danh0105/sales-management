import { Injectable } from '@nestjs/common';

import { NotificationService } from './notification.service';

import { NotificationType } from '../enums/notification-type.enum';

@Injectable()
export class ReportNotificationService {
    constructor(
        private readonly notificationService: NotificationService,
    ) { }

    // ======================================================
    // CREATE
    // ======================================================

    async create(data: {
        receiverId: number;

        reportId: number;

        senderId?: number;

        message?: string;
    }) {
        return this.notificationService.create({
            receiverId: data.receiverId,

            senderId: data.senderId,

            type: NotificationType.REPORT,

            entityId: data.reportId,

            message:
                data.message ??
                'Bạn có báo cáo mới',

            meta: {
                reportId: data.reportId,
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

            type: NotificationType.REPORT,
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

            NotificationType.REPORT,
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

            NotificationType.REPORT,
        );
    }

    // ======================================================
    // GROUPED BY SENDER (EMPLOYEE) — trả về toàn bộ nhân viên
    // ======================================================

    async findGroupedBySender(data: {
        receiverId: number;
        date: string;
    }) {
        return this.notificationService.findAllEmployeesWithNotifications({
            receiverId: data.receiverId,
            type: NotificationType.REPORT,
            date: data.date,
        });
    }

    // ======================================================
    // FIND BY SENDER
    // ======================================================

    async findBySender(data: {
        receiverId: number;
        senderId: number;
        tab?: 'unread' | 'read';
        page?: number;
        limit?: number;
        date: string;
    }) {
        return this.notificationService.findBySender({
            receiverId: data.receiverId,
            senderId: data.senderId,
            type: NotificationType.REPORT,
            tab: data.tab,
            page: data.page,
            limit: data.limit,
            date: data.date,
        });
    }

    // ======================================================
    // MARK ALL AS READ BY SENDER
    // ======================================================

    async markAllAsReadBySender(
        receiverId: number,
        senderId: number,
    ) {
        return this.notificationService.markAllAsReadBySender({
            receiverId,
            senderId,
            type: NotificationType.REPORT,
        });
    }
}