import {
    Controller,
    Get,
    Patch,
    Query,
    Req,
    Param,
    ParseIntPipe,
    UseGuards,
    DefaultValuePipe,
    UnauthorizedException,
} from '@nestjs/common';

import type { Request } from 'express';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard';

import { ReportNotificationService } from '../services/report-notification.service';

@Controller('notifications/report')
@UseGuards(JwtAuthGuard)
export class ReportNotificationController {
    constructor(
        private readonly reportNotificationService: ReportNotificationService,
    ) { }

    // ======================================================
    // HELPERS
    // ======================================================

    private getEmployeeId(
        req: Request,
    ): number {
        if (!req.user) {
            throw new UnauthorizedException();
        }

        return req.user['id'];
    }

    // ======================================================
    // GET REPORT NOTIFICATIONS
    // GET /notifications/report?page=1&limit=10&tab=unread
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
    ) {
        return this.reportNotificationService.findAll({
            receiverId: this.getEmployeeId(req),

            page,

            limit,

            tab,
        });
    }

    // ======================================================
    // GROUPED BY SENDER (EMPLOYEE)
    // GET /notifications/report/grouped
    //   → mặc định hiện hôm nay, trả về toàn bộ nhân viên
    // GET /notifications/report/grouped?date=2026-06-18
    //   → "Xem thêm" — FE gửi ngày trước đó
    // ======================================================

    @Get('grouped')
    async findGroupedBySender(
        @Req() req: Request,

        @Query('date')
        date?: string,
    ) {
        const targetDate =
            date || new Date().toISOString().split('T')[0];

        return this.reportNotificationService.findGroupedBySender({
            receiverId: this.getEmployeeId(req),
            date: targetDate,
        });
    }

    // ======================================================
    // NOTIFICATIONS BY SENDER
    // GET /notifications/report/sender/:senderId
    //   → mặc định hiện hôm nay
    // GET /notifications/report/sender/:senderId?date=2026-06-18
    //   → "Xem thêm" — FE gửi ngày trước đó
    // ======================================================

    @Get('sender/:senderId')
    async findBySender(
        @Req() req: Request,

        @Param('senderId', ParseIntPipe)
        senderId: number,

        @Query(
            'page',
            new DefaultValuePipe(1),
            ParseIntPipe,
        )
        page: number,

        @Query(
            'limit',
            new DefaultValuePipe(20),
            ParseIntPipe,
        )
        limit: number,

        @Query('tab')
        tab?: 'unread' | 'read',

        @Query('date')
        date?: string,
    ) {
        const targetDate =
            date || new Date().toISOString().split('T')[0];

        return this.reportNotificationService.findBySender({
            receiverId: this.getEmployeeId(req),
            senderId,
            page,
            limit,
            tab,
            date: targetDate,
        });
    }

    // ======================================================
    // MARK ALL AS READ BY SENDER
    // PATCH /notifications/report/sender/:senderId/read-all
    // ======================================================

    @Patch('sender/:senderId/read-all')
    async markAllAsReadBySender(
        @Req() req: Request,

        @Param('senderId', ParseIntPipe)
        senderId: number,
    ) {
        return this.reportNotificationService.markAllAsReadBySender(
            this.getEmployeeId(req),
            senderId,
        );
    }

    // ======================================================
    // UNREAD COUNT
    // GET /notifications/report/unread-count
    // ======================================================

    @Get('unread-count')
    async unreadCount(
        @Req() req: Request,
    ) {
        return this.reportNotificationService.countUnread(
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK AS READ
    // PATCH /notifications/report/:id/read
    // ======================================================

    @Patch(':id/read')
    async markAsRead(
        @Param('id', ParseIntPipe)
        id: number,

        @Req() req: Request,
    ) {
        return this.reportNotificationService.markAsRead(
            id,

            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK ALL AS READ
    // PATCH /notifications/report/read-all
    // ======================================================

    @Patch('read-all')
    async markAllAsRead(
        @Req() req: Request,
    ) {
        return this.reportNotificationService.markAllAsRead(
            this.getEmployeeId(req),
        );
    }
}