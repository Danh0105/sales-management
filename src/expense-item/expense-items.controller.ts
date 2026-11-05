import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';

import { ExpenseItemsService } from './expense-items.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    CASHFLOW_READ_ROLES,
    CASHFLOW_WRITE_ROLES,
} from '../school-expenses/cashflow-roles';

@Controller('expense-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_WRITE_ROLES)
export class ExpenseItemsController {
    constructor(
        private readonly expenseItemsService: ExpenseItemsService,
    ) {}

    @Post()
    create(@Body() body: any) {
        return this.expenseItemsService.create(
            body,
        );
    }

    @Get()
    @Roles(...CASHFLOW_READ_ROLES)
    findAll(@Query() query: any) {
        return this.expenseItemsService.findAll(
            query,
        );
    }

    @Get(':id')
    @Roles(...CASHFLOW_READ_ROLES)
    findOne(
        @Param('id') id: string,
    ) {
        return this.expenseItemsService.findOne(
            Number(id),
        );
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() body: any,
    ) {
        return this.expenseItemsService.update(
            Number(id),
            body,
        );
    }

    @Delete(':id')
    remove(
        @Param('id') id: string,
    ) {
        return this.expenseItemsService.remove(
            Number(id),
        );
    }
}
