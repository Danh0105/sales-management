import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { Subject } from '../subject/subject.entity';
import { RevenueEInvoice } from './revenue-einvoice.entity';
import { RevenueEInvoicesController } from './revenue-einvoices.controller';
import { RevenueEInvoicesService } from './revenue-einvoices.service';
import { ViettelSinvoiceClient } from './viettel-sinvoice.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RevenueEInvoice,
      SchoolExpense,
      Subject,
      RevenueItem,
      SchoolExpenseItem,
    ]),
  ],
  controllers: [RevenueEInvoicesController],
  providers: [RevenueEInvoicesService, ViettelSinvoiceClient],
})
export class RevenueEInvoicesModule {}
