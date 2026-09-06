import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { RealExpensesService } from './real-expenses.service';
import { RealExpensesController } from './real-expenses.controller';

import { SchoolExpense } from './entities/school-expenses.entity';
import { SchoolExpenseHistory } from './entities/school-expense-history.entity';

import { School } from '../school/schools.entity';

import { ExpensePeriod } from '../expense-periods/expense-period.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { ManagementExpenseOtherCost } from '../management-expense-item/management-expense-other-cost.entity';
import { Subject } from '../subject/subject.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            SchoolExpense,
            SchoolExpenseHistory,
            School,
            ExpensePeriod,
            RevenueItem,
            SchoolExpenseItem,
            ManagementExpenseItem,
            ManagementExpenseOtherCost,
            Subject,
        ]),
    ],

    controllers: [
        RealExpensesController,
    ],

    providers: [
        RealExpensesService,
    ],

    exports: [
        RealExpensesService,
    ],
})
export class SchoolExpensesModule {}