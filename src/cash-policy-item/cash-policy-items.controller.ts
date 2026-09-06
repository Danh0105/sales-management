import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';

import { CashPolicyItemsService } from './cash-policy-items.service';

@Controller('cash-policy-items')
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
    findAll(@Query() query: any) {
        return this.cashPolicyItemsService.findAll(
            query,
        );
    }

    @Get(':id')
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