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

import { SuggestNotificationService } from '../services/suggest-notification.service';

@Controller('notifications/suggest')
@UseGuards(JwtAuthGuard)
export class SuggestNotificationController {
    constructor(
        private readonly suggestNotificationService: SuggestNotificationService,
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
    // GET SUGGEST NOTIFICATIONS
    // GET /notifications/suggest?page=1&limit=10&tab=unread
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
        return this.suggestNotificationService.findAll({
            receiverId: this.getEmployeeId(req),

            page,

            limit,

            tab,
        });
    }

    // ======================================================
    // UNREAD COUNT
    // GET /notifications/suggest/unread-count
    // ======================================================

    @Get('unread-count')
    async unreadCount(
        @Req() req: Request,
    ) {
        return this.suggestNotificationService.countUnread(
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK AS READ
    // PATCH /notifications/suggest/:id/read
    // ======================================================

    @Patch(':id/read')
    async markAsRead(
        @Param('id', ParseIntPipe)
        id: number,

        @Req() req: Request,
    ) {
        return this.suggestNotificationService.markAsRead(
            id,

            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK ALL AS READ
    // PATCH /notifications/suggest/read-all
    // ======================================================

    @Patch('read-all')
    async markAllAsRead(
        @Req() req: Request,
    ) {
        return this.suggestNotificationService.markAllAsRead(
            this.getEmployeeId(req),
        );
    }
}