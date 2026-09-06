import {
    Controller,
    Get,
    Patch,
    Req,
    Param,
    Query,
    ParseIntPipe,
    DefaultValuePipe,
    UseGuards,
    UnauthorizedException,
} from '@nestjs/common';

import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { NotificationService } from '../services/notification.service';
import { NotificationType } from '../enums/notification-type.enum';



@Controller('notifications/policy')
@UseGuards(JwtAuthGuard)
export class PolicyNotificationController {
    constructor(
        private readonly notificationService: NotificationService,
    ) { }
    private getEmployeeId(
        req: Request,
    ): number {
        if (!req.user) {
            throw new UnauthorizedException();
        }

        return req.user.id;
    }

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
        return this.notificationService.findByType({
            receiverId: this.getEmployeeId(req),

            type: NotificationType.POLICY,

            page,

            limit,

            tab,
        });
    }

    @Get('unread-count')
    async unreadCount(
        @Req() req: Request,
    ) {
        return this.notificationService.countUnreadByType(
            this.getEmployeeId(req),

            NotificationType.POLICY,
        );
    }

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

    @Patch('read-all')
    async markAllAsRead(
        @Req() req: Request,
    ) {
        return this.notificationService.markAllAsReadByType(
            this.getEmployeeId(req),

            NotificationType.POLICY,
        );
    }
}