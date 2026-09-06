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

import { ExpenseItemsService } from './expense-items.service';

@Controller('expense-items')
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
    findAll(@Query() query: any) {
        return this.expenseItemsService.findAll(
            query,
        );
    }

    @Get(':id')
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