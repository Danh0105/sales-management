import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { ExpensePeriod } from './expense-period.entity';

import { ExpensePeriodsController } from './expense-periods.controller';
import { ExpensePeriodsService } from './expense-periods.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            ExpensePeriod,
        ]),
    ],

    controllers: [
        ExpensePeriodsController,
    ],

    providers: [
        ExpensePeriodsService,
    ],

    exports: [
        ExpensePeriodsService,
    ],
})
export class ExpensePeriodsModule {}