import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { CashPolicyItem } from './cash-policy-item.entity';

import { CashPolicyItemsController } from './cash-policy-items.controller';
import { CashPolicyItemsService } from './cash-policy-items.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            CashPolicyItem,
            SchoolExpense,
        ]),
    ],

    controllers: [
        CashPolicyItemsController,
    ],

    providers: [
        CashPolicyItemsService,
    ],

    exports: [
        CashPolicyItemsService,
    ],
})
export class CashPolicyItemsModule {}