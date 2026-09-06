import {
    Controller,
    Get,
    Patch,
    UseGuards,
    Req,
    Param,
    ParseIntPipe,
    UnauthorizedException,
    Query,
    DefaultValuePipe,
    BadRequestException,
} from '@nestjs/common';

import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

import { NotificationService } from '../services/notification.service';
import { NotificationType } from '../enums/notification-type.enum';



@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
    constructor(
        private readonly notificationService: NotificationService,
    ) { }

    // ======================================================
    // HELPERS
    // ======================================================

    private getEmployeeId(req: Request): number {
        if (!req.user) {
            throw new UnauthorizedException();
        }

        return req.user.id;
    }

    private validateType(
        type?: string,
    ): NotificationType | undefined {
        if (!type) return undefined;

        const values = Object.values(NotificationType);

        if (!values.includes(type as NotificationType)) {
            throw new BadRequestException(
                `Invalid notification type: ${type}`,
            );
        }

        return type as NotificationType;
    }

    // ======================================================
    // COUNT UNREAD
    // GET /notifications/unread-count
    // ======================================================

    @Get('unread-count')
    async countUnread(
        @Req() req: Request,
    ) {
        return this.notificationService.countUnread(
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // GET UNREAD
    // GET /notifications/unread
    // ======================================================

    @Get('unread')
    async getUnread(
        @Req() req: Request,
    ) {
        return this.notificationService.getUnreadNotifications(
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // GET ALL
    // GET /notifications?page=1&limit=10
    // ======================================================

    @Get()
    async findAll(
        @Req() req: Request,

        @Query(
            'page',
            new DefaultValuePipe(1),
            ParseIntPipe,
        )
        page: number,

        @Query(
            'limit',
            new DefaultValuePipe(10),
            ParseIntPipe,
        )
        limit: number,

        @Query('tab')
        tab?: 'unread' | 'read',

        @Query('type')
        type?: string,
    ) {
        const employeeId = this.getEmployeeId(req);

        const safeType = this.validateType(type);

        return this.notificationService.findAllWithPagination({
            receiverId: employeeId,

            page,

            limit,

            tab,

            type: safeType,
        });
    }

    // ======================================================
    // MARK AS READ
    // PATCH /notifications/:id/read
    // ======================================================

    @Patch(':id/read')
    async markAsRead(
        @Param('id', ParseIntPipe)
        id: number,

        @Req() req: Request,
    ) {
        return this.notificationService.markAsRead(
            id,
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK ALL AS READ
    // PATCH /notifications/read-all
    // ======================================================

    @Patch('read-all')
    async markAllAsRead(
        @Req() req: Request,
    ) {
        return this.notificationService.markAllAsRead(
            this.getEmployeeId(req),
        );
    }
    @UseGuards(JwtAuthGuard)
    @Get('stats')
    getStats(@Req() req) {
        return this.notificationService.getNotificationStats(
            req.user.id,
        );
    }
}