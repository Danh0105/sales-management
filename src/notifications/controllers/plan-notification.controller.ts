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
import { WeeklyPlanNotificationService } from '../services/weekly-plan-notification.service';



@Controller('notifications/plan')
@UseGuards(JwtAuthGuard)
export class PlanNotificationController {
    constructor(
        private readonly planNotificationService: WeeklyPlanNotificationService,
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
    // GET PLAN NOTIFICATIONS
    // GET /notifications/plan?page=1&limit=10&tab=unread
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
        return this.planNotificationService.findAll({
            receiverId: this.getEmployeeId(req),

            page,

            limit,

            tab,
        });
    }

    // ======================================================
    // UNREAD COUNT
    // GET /notifications/plan/unread-count
    // ======================================================

    @Get('unread-count')
    async unreadCount(
        @Req() req: Request,
    ) {
        return this.planNotificationService.countUnread(
            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK AS READ
    // PATCH /notifications/plan/:id/read
    // ======================================================

    @Patch(':id/read')
    async markAsRead(
        @Param('id', ParseIntPipe)
        id: number,

        @Req() req: Request,
    ) {
        return this.planNotificationService.markAsRead(
            id,

            this.getEmployeeId(req),
        );
    }

    // ======================================================
    // MARK ALL AS READ
    // PATCH /notifications/plan/read-all
    // ======================================================

    @Patch('read-all')
    async markAllAsRead(
        @Req() req: Request,
    ) {
        return this.planNotificationService.markAllAsRead(
            this.getEmployeeId(req),
        );
    }
}