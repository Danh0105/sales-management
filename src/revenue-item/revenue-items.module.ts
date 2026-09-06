import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { RevenueItem } from './revenue-item.entity';
import { Subject } from '../subject/subject.entity';

import { RevenueItemsController } from './revenue-items.controller';
import { RevenueItemsService } from './revenue-items.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            RevenueItem,
            SchoolExpense,
            SchoolExpenseHistory,
            Subject,
        ]),
    ],

    controllers: [
        RevenueItemsController,
    ],

    providers: [
        RevenueItemsService,
    ],

    exports: [
        RevenueItemsService,
    ],
})
export class RevenueItemsModule {}
