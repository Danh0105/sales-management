import {
    Controller,
    DefaultValuePipe,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Query,
    Req,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';

import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { NotificationService } from '../services/notification.service';

/**
 * Thông báo lịch dạy của chính người đăng nhập (giáo viên).
 * Cùng shape với /notifications/policy để FE dùng lại y nguyên phần hiển thị.
 */
@Controller('notifications/teaching-schedule')
@UseGuards(JwtAuthGuard)
export class TeachingScheduleNotificationController {
    constructor(
        private readonly notificationService: NotificationService,
    ) { }

    private getEmployeeId(req: Request): number {
        if (!req.user) {
            throw new UnauthorizedException();
        }

        return req.user.id;
    }

    @Get()
    async findAll(
        @Req() req: Request,

        @Query('page', new DefaultValuePipe(1), ParseIntPipe)
        page: number,

        @Query('limit', new DefaultValuePipe(10), ParseIntPipe)
        limit: number,

        @Query('tab')
        tab?: 'unread' | 'read',
    ) {
        return this.notificationService.findTeachingSchedule({
            receiverId: this.getEmployeeId(req),
            page,
            limit,
            tab,
        });
    }

    @Get('unread-count')
    async unreadCount(@Req() req: Request) {
        return this.notificationService.countUnreadTeachingSchedule(
            this.getEmployeeId(req),
        );
    }

    @Patch('read-all')
    async markAllAsRead(@Req() req: Request) {
        return this.notificationService.markAllTeachingScheduleAsRead(
            this.getEmployeeId(req),
        );
    }

    @Patch(':id/read')
    async markAsRead(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: Request,
    ) {
        return this.notificationService.markAsRead(
            id,
            this.getEmployeeId(req),
        );
    }
}
