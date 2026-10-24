import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';
import { CashflowReportService } from './cashflow-report.service';
import { CashflowQueryDto } from './dto/cashflow-query.dto';
import { UpdateCashAccountDto } from './dto/update-cash-account.dto';

type RequestWithUser = Request & { user: AuthUser };

/** Xem báo cáo: bộ phận kế toán / thủ quỹ / ban giám đốc. */
const READ_ROLES = [
  'accountant',
  'ketoan_congno',
  'ketoan_truong',
  'thuquy',
  'troly_gd',
  'director',
];

/** Sửa số dư gốc, trạng thái tài khoản: kế toán trưởng, giám đốc. */
const MANAGE_ROLES = ['ketoan_truong', 'director'];

@Controller('reports/cashflow')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class CashflowReportController {
  constructor(private readonly cashflowReportService: CashflowReportService) {}

  @Get('summary')
  summary(@Query() query: CashflowQueryDto) {
    return this.cashflowReportService.getSummary(query);
  }

  @Get('accounts')
  accounts(@Query() query: CashflowQueryDto) {
    return this.cashflowReportService.getAccounts(query);
  }

  @Get('cash')
  cash(@Query() query: CashflowQueryDto) {
    return this.cashflowReportService.getLedger('111', query);
  }

  @Get('bank')
  bank(@Query() query: CashflowQueryDto) {
    return this.cashflowReportService.getLedger('112', query);
  }

  /** Chứng từ chưa phân loại / thiếu thông tin / trùng / bất thường. */
  @Get('issues')
  issues(@Query() query: CashflowQueryDto) {
    return this.cashflowReportService.getIssues(query);
  }

  @Patch('accounts/:code')
  @Roles(...MANAGE_ROLES)
  updateAccount(
    @Param('code') code: string,
    @Body() dto: UpdateCashAccountDto,
    @Req() req: RequestWithUser,
  ) {
    return this.cashflowReportService.updateAccount(code, dto, req.user);
  }
}
