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

import { ExpensePeriodsService } from './expense-periods.service';

@Controller('expense-periods')
export class ExpensePeriodsController {
    constructor(
        private readonly expensePeriodsService: ExpensePeriodsService,
    ) {}

    @Post()
    create(@Body() body: any) {
        return this.expensePeriodsService.create(
            body,
        );
    }

    @Get()
    findAll(@Query() query: any) {
        return this.expensePeriodsService.findAll(
            query,
        );
    }

    @Get(':id')
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