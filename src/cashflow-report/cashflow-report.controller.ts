import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AuthUser } from '../type/auth-user.type';
import { CashDayClosingService } from './cash-day-closing.service';
import { CashManualEntryService } from './cash-manual-entry.service';
import { CashflowReportService } from './cashflow-report.service';
import { SourceDeletionService } from './source-deletion.service';
import { CashflowQueryDto } from './dto/cashflow-query.dto';
import { CreateCashAccountDto } from './dto/create-cash-account.dto';
import {
  CloseDayDto,
  DayClosingRangeDto,
  ReopenDayDto,
} from './dto/day-closing.dto';
import {
  CreateManualEntryDto,
  UpdateManualEntryDto,
} from './dto/manual-entry.dto';
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

/**
 * Thêm/sửa/xoá dữ liệu của báo cáo (danh mục tài khoản, số dư gốc, bút toán
 * nhập tay): kế toán trưởng, thủ quỹ, giám đốc. Phải khớp `canManage` ở giao diện.
 */
export const MANAGE_ROLES = ['ketoan_truong', 'thuquy', 'director'];

/** Mở lại ngày đã chốt quỹ: kế toán trưởng, giám đốc. */
export const REOPEN_ROLES = ['ketoan_truong', 'director'];

@Controller('reports/cashflow')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...READ_ROLES)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class CashflowReportController {
  constructor(
    private readonly cashflowReportService: CashflowReportService,
    private readonly manualEntryService: CashManualEntryService,
    private readonly sourceDeletionService: SourceDeletionService,
    private readonly dayClosingService: CashDayClosingService,
  ) {}

  /** Trạng thái chốt quỹ (ngày chốt gần nhất) — mọi người xem báo cáo đều thấy. */
  @Get('day-closings/status')
  dayClosingStatus() {
    return this.dayClosingService.status();
  }

  @Get('day-closings/preview')
  @Roles(...MANAGE_ROLES)
  dayClosingPreview(@Query() dto: CloseDayDto) {
    return this.dayClosingService.preview(dto.date);
  }

  @Get('day-closings')
  dayClosings(@Query() query: DayClosingRangeDto) {
    return this.dayClosingService.list(query.from, query.to);
  }

  /** End of Day: chốt quỹ ngày (mặc định hôm nay) và các ngày chưa chốt trước đó. */
  @Post('day-closings')
  @Roles(...MANAGE_ROLES)
  closeDay(@Body() dto: CloseDayDto, @Req() req: RequestWithUser) {
    return this.dayClosingService.close(req.user, dto.date);
  }

  @Post('day-closings/reopen')
  @Roles(...REOPEN_ROLES)
  reopenDay(@Body() dto: ReopenDayDto, @Req() req: RequestWithUser) {
    return this.dayClosingService.reopen(req.user, dto.reason);
  }

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

  /** Excel 3 sheet theo file mẫu: DANH MỤC CÁC TK, Tiền mặt, Tiền gửi ngân hàng. */
  @Get('export')
  async export(@Query() query: CashflowQueryDto, @Res() res: Response) {
    const { buffer, fileName } =
      await this.cashflowReportService.exportExcel(query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(buffer);
  }

  @Post('accounts')
  @Roles(...MANAGE_ROLES)
  createAccount(
    @Body() dto: CreateCashAccountDto,
    @Req() req: RequestWithUser,
  ) {
    return this.cashflowReportService.createAccount(dto, req.user);
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

  @Delete('accounts/:code')
  @Roles(...MANAGE_ROLES)
  deleteAccount(@Param('code') code: string) {
    return this.cashflowReportService.deleteAccount(code);
  }

  /**
   * Xoá một dòng trên sổ: xem trước các khoản bị xoá / gỡ (để người xoá xác
   * nhận), rồi xoá. Đề nghị tài chính / Đề xuất chi / Thu Chi ngoài xoá hẳn
   * chứng từ gốc; Hóa Đơn / Chi Trường / Chi Ngoài chỉ gỡ khoản thu chi.
   */
  @Get('sources/:type/:id/deletion')
  @Roles(...MANAGE_ROLES)
  sourceDeletionPlan(
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.sourceDeletionService.plan(type, id);
  }

  @Delete('sources/:type/:id')
  @Roles(...MANAGE_ROLES)
  deleteSource(
    @Param('type') type: string,
    @Param('id', ParseIntPipe) id: number,
    @Req() req: RequestWithUser,
  ) {
    return this.sourceDeletionService.execute(type, id, req.user);
  }

  /** Bút toán thu/chi/chuyển nội bộ nhập tay (dòng nguồn MANUAL_ENTRY trên sổ). */
  @Get('manual-entries/:id')
  @Roles(...MANAGE_ROLES)
  getManualEntry(@Param('id', ParseIntPipe) id: number) {
    return this.manualEntryService.get(id);
  }

  @Post('manual-entries')
  @Roles(...MANAGE_ROLES)
  createManualEntry(
    @Body() dto: CreateManualEntryDto,
    @Req() req: RequestWithUser,
  ) {
    return this.manualEntryService.create(dto, req.user);
  }

  @Patch('manual-entries/:id')
  @Roles(...MANAGE_ROLES)
  updateManualEntry(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateManualEntryDto,
    @Req() req: RequestWithUser,
  ) {
    return this.manualEntryService.update(id, dto, req.user);
  }

  @Delete('manual-entries/:id')
  @Roles(...MANAGE_ROLES)
  deleteManualEntry(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: RequestWithUser,
  ) {
    return this.manualEntryService.remove(id, req.user);
  }
}
