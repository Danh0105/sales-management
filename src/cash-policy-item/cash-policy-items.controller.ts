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

import { CashPolicyItemsService } from './cash-policy-items.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    CASHFLOW_READ_ROLES,
    CASHFLOW_WRITE_ROLES,
} from '../school-expenses/cashflow-roles';

@Controller('cash-policy-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_WRITE_ROLES)
export class CashPolicyItemsController {
    constructor(
        private readonly cashPolicyItemsService: CashPolicyItemsService,
    ) {}

    @Post()
    create(@Body() body: any) {
        return this.cashPolicyItemsService.create(
            body,
        );
    }

    @Get()
    @Roles(...CASHFLOW_READ_ROLES)
    findAll(@Query() query: any) {
        return this.cashPolicyItemsService.findAll(
            query,
        );
    }

    @Get(':id')
    @Roles(...CASHFLOW_READ_ROLES)
    findOne(
        @Param('id') id: string,
    ) {
        return this.cashPolicyItemsService.findOne(
            Number(id),
        );
    }

    @Patch(':id')
    update(
        @Param('id') id: string,
        @Body() body: any,
    ) {
        return this.cashPolicyItemsService.update(
            Number(id),
            body,
        );
    }

    @Delete(':id')
    remove(
        @Param('id') id: string,
    ) {
        return this.cashPolicyItemsService.remove(
            Number(id),
        );
    }
}
