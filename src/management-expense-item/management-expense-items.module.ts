import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ManagementExpenseItem } from './management-expense-item.entity';
import { ManagementExpenseOtherCost } from './management-expense-other-cost.entity';
import { Subject } from '../subject/subject.entity';

import { ManagementExpenseItemsController } from './management-expense-items.controller';
import { ManagementExpenseItemsService } from './management-expense-items.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ManagementExpenseItem,
            ManagementExpenseOtherCost,
            SchoolExpense,
            SchoolExpenseHistory,
            Subject,
        ]),
    ],

    controllers: [
        ManagementExpenseItemsController,
    ],

    providers: [
        ManagementExpenseItemsService,
    ],

    exports: [
        ManagementExpenseItemsService,
    ],
})
export class ManagementExpenseItemsModule {}
