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
import { ExpenseNotificationService } from '../services/expense-notification.service';

/**
 * Thông báo ĐỀ XUẤT CHI cho chuông thông báo.
 * - Gom nhóm theo nhân viên kinh doanh: /grouped-by-employee
 * - Tab cảnh báo quá hạn riêng: dùng scope=overdue
 */
@Controller('notifications/expense')
@UseGuards(JwtAuthGuard)
export class ExpenseNotificationController {
    constructor(private readonly service: ExpenseNotificationService) { }

    private getEmployeeId(req: Request): number {
        if (!req.user) throw new UnauthorizedException();
        return req.user['id'];
    }

    /** Badge cho các tab: { general: {total, unread}, overdue: {total, unread} }. */
    @Get('summary')
    summary(@Req() req: Request) {
        return this.service.summary(this.getEmployeeId(req));
    }

    /** Gom nhóm theo nhân viên kinh doanh (phân trang theo nhân viên). */
    @Get('grouped-by-employee')
    groupedByEmployee(
        @Req() req: Request,
        @Query('scope') scope?: string,
        @Query('tab') tab?: 'unread' | 'read',
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
        @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    ) {
        return this.service.groupedByEmployee({
            receiverId: this.getEmployeeId(req),
            scope,
            tab,
            page,
            limit,
        });
    }

    /** Danh sách phẳng: tab quá hạn (scope=overdue) hoặc bung 1 nhân viên (employeeId). */
    @Get()
    list(
        @Req() req: Request,
        @Query('scope') scope?: string,
        @Query('tab') tab?: 'unread' | 'read',
        @Query('employeeId') employeeId?: string,
        @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
        @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit?: number,
    ) {
        return this.service.list({
            receiverId: this.getEmployeeId(req),
            scope,
            tab,
            employeeId: employeeId ? Number(employeeId) : undefined,
            page,
            limit,
        });
    }

    @Patch('read-all')
    markAllAsRead(
        @Req() req: Request,
        @Query('scope') scope?: string,
        @Query('employeeId') employeeId?: string,
    ) {
        return this.service.markAllAsRead({
            receiverId: this.getEmployeeId(req),
            scope,
            employeeId: employeeId ? Number(employeeId) : undefined,
        });
    }

    @Patch(':id/read')
    markAsRead(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: Request,
    ) {
        return this.service.markAsRead(id, this.getEmployeeId(req));
    }
}
