import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FinancialRequestModule } from '../financial-request/financial-request.module';
import { CashAccount } from './cash-account.entity';
import { CashManualEntry } from './cash-manual-entry.entity';
import { CashManualEntryService } from './cash-manual-entry.service';
import { CashflowReportController } from './cashflow-report.controller';
import { CashflowReportService } from './cashflow-report.service';
import { SourceDeletionService } from './source-deletion.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([CashAccount, CashManualEntry]),
    FinancialRequestModule,
  ],
  controllers: [CashflowReportController],
  providers: [
    CashflowReportService,
    CashManualEntryService,
    SourceDeletionService,
  ],
})
export class CashflowReportModule {}
