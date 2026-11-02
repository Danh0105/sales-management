import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashAccount } from './cash-account.entity';
import { CashManualEntry } from './cash-manual-entry.entity';
import { CashManualEntryService } from './cash-manual-entry.service';
import { CashflowReportController } from './cashflow-report.controller';
import { CashflowReportService } from './cashflow-report.service';

@Module({
  imports: [TypeOrmModule.forFeature([CashAccount, CashManualEntry])],
  controllers: [CashflowReportController],
  providers: [CashflowReportService, CashManualEntryService],
})
export class CashflowReportModule {}
