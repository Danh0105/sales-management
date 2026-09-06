import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { SchoolExpenseItem } from './school-expense-item.entity';
import { Subject } from '../subject/subject.entity';

import { SchoolExpenseItemsController } from './school-expense-items.controller';
import { SchoolExpenseItemsService } from './school-expense-items.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            SchoolExpenseItem,
            SchoolExpense,
            SchoolExpenseHistory,
            Subject,
        ]),
    ],

    controllers: [
        SchoolExpenseItemsController,
    ],

    providers: [
        SchoolExpenseItemsService,
    ],

    exports: [
        SchoolExpenseItemsService,
    ],
})
export class SchoolExpenseItemsModule {}
