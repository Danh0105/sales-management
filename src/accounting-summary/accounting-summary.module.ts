import { Module } from '@nestjs/common';
import { AccountingSummaryController } from './accounting-summary.controller';
import { AccountingSummaryService } from './accounting-summary.service';

@Module({
  controllers: [AccountingSummaryController],
  providers: [AccountingSummaryService],
})
export class AccountingSummaryModule {}
