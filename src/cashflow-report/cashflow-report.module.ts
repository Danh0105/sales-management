import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CashAccount } from './cash-account.entity';
import { CashflowReportController } from './cashflow-report.controller';
import { CashflowReportService } from './cashflow-report.service';

@Module({
  imports: [TypeOrmModule.forFeature([CashAccount])],
  controllers: [CashflowReportController],
  providers: [CashflowReportService],
})
export class CashflowReportModule {}
