import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ExpenseItem } from './expense-item.entity';
import { Subject } from '../subject/subject.entity';

import { ExpenseItemsController } from './expense-items.controller';
import { ExpenseItemsService } from './expense-items.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ExpenseItem,
            SchoolExpense,
            Subject,
        ]),
    ],

    controllers: [
        ExpenseItemsController,
    ],

    providers: [
        ExpenseItemsService,
    ],

    exports: [
        ExpenseItemsService,
    ],
})
export class ExpenseItemsModule {}