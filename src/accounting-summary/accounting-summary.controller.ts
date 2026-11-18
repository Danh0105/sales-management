import {
  Controller,
  Get,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AccountingSummaryService } from './accounting-summary.service';
import { QueryCashflowSummaryDto } from './dto/query-cashflow-summary.dto';

export const ACCOUNTING_SUMMARY_ROLES = [
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'troly_gd',
  'director',
];

@ApiBearerAuth()
@Controller('accounting')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ACCOUNTING_SUMMARY_ROLES)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AccountingSummaryController {
  constructor(private readonly service: AccountingSummaryService) {}

  @Get('cashflow-summary')
  @ApiOperation({
    summary: 'Tổng hợp thu, chi và công nợ theo trường/kỳ kế toán',
  })
  getCashflowSummary(@Query() query: QueryCashflowSummaryDto) {
    return this.service.getCashflowSummary(query);
  }
}
