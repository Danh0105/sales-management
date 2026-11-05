import {
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';

import { ExpensePeriodsService } from './expense-periods.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    CASHFLOW_CREATE_ROLES,
    CASHFLOW_READ_ROLES,
    CASHFLOW_WRITE_ROLES,
} from '../school-expenses/cashflow-roles';

@Controller('expense-periods')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_WRITE_ROLES)
export class ExpensePeriodsController {
    constructor(
        private readonly expensePeriodsService: ExpensePeriodsService,
    ) {}

    // Sales admin cần kỳ của tháng để tạo bảng chi phí rỗng, nhưng không được
    // thêm dòng tuỳ chỉnh (không có tháng, hoặc tháng ảo > 12).
    @Post()
    @Roles(...CASHFLOW_CREATE_ROLES)
    create(@Body() body: any, @Req() req: any) {
        const canWrite = (req.user?.roles ?? []).some((role: string) =>
            (CASHFLOW_WRITE_ROLES as readonly string[]).includes(role),
        );
        const month = Number(body?.month);
        if (!canWrite && !(month >= 1 && month <= 12)) {
            throw new ForbiddenException(
                'Sales admin chỉ được tạo kỳ theo tháng',
            );
        }
        return this.expensePeriodsService.create(
            body,
        );
    }

    // DUPLICATE — nhân bản kỳ chi phí kèm toàn bộ dữ liệu thu chi
    @Post(':id/duplicate')
    duplicate(
        @Param('id') id: string,
        @Body() body: { name?: string },
    ) {
        return this.expensePeriodsService.duplicate(
            Number(id),
            body,
        );
    }

    @Get()
    @Roles(...CASHFLOW_READ_ROLES)
    findAll(@Query() query: any) {
        return this.expensePeriodsService.findAll(
            query,
        );
    }

    @Get(':id')
    @Roles(...CASHFLOW_READ_ROLES)
    findOne(
        @Param('id') id: string,
    ) {
        return this.expensePeriodsService.findOne(
            Number(id),
        );
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() body: any,
    ) {
        return this.expensePeriodsService.update(
            Number(id),
            body,
        );
    }

    @Delete(':id')
    remove(
        @Param('id') id: string,
    ) {
        return this.expensePeriodsService.remove(
            Number(id),
        );
    }

    // LOCK
    @Patch(':id/lock')
    lock(
        @Param('id') id: string,
    ) {
        return this.expensePeriodsService.lock(
            Number(id),
        );
    }

    // OPEN
    @Patch(':id/open')
    open(
        @Param('id') id: string,
    ) {
        return this.expensePeriodsService.open(
            Number(id),
        );
    }
}
