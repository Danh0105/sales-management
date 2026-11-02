import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../type/auth-user.type';
import {
  AdjustItemsDto,
  ApproveStepDto,
  BalanceQueryDto,
  ConfirmDeductionDto,
  DecideStepDto,
  ExportQueryDto,
  MoneyMovementDto,
  ReasonDto,
  UploadAttachmentDto,
  WithdrawDto,
} from './dto/financial-action.dto';
import {
  AssignmentDto,
  CategoryDto,
  CompanyDto,
  DelegationDto,
  PolicyDto,
  UpdateCategoryDto,
  UpdateCompanyDto,
  WorkflowDto,
} from './dto/financial-config.dto';
import {
  AvailableAdvancesQueryDto,
  CreateFinancialRequestDto,
  DeductionQueryDto,
  FinancialReportQueryDto,
  FinancialRequestQueryDto,
  SalaryAdvanceCheckQueryDto,
  SavePayeeProfileDto,
  UpdateFinancialRequestDto,
} from './dto/financial-request.dto';
import { FinancialConfigService } from './financial-config.service';
import { FinancialLedgerService } from './financial-ledger.service';
import { FinancialPdfService } from './financial-pdf.service';
import { FinancialReportService } from './financial-report.service';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_FILES,
} from './financial-request.constants';
import { FinancialRequestService } from './financial-request.service';
import { contentDisposition } from './financial-storage';

type RequestWithUser = { user: AuthUser };

const uploadOptions = {
  storage: memoryStorage(),
  limits: { fileSize: ATTACHMENT_MAX_BYTES, files: ATTACHMENT_MAX_FILES },
};

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Cấu hình phân hệ — khai báo TRƯỚC controller chính trong module để
 * `/financial-requests/config` không rơi vào route `/:id`.
 */
@Controller('financial-requests/config')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class FinancialConfigController {
  constructor(private readonly config: FinancialConfigService) {}

  @Get()
  overview(@Req() req: RequestWithUser) {
    return this.config.overview(req.user);
  }

  @Post('companies')
  createCompany(@Req() req: RequestWithUser, @Body() dto: CompanyDto) {
    return this.config.createCompany(req.user, dto);
  }

  @Patch('companies/:id')
  updateCompany(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.config.updateCompany(req.user, id, dto);
  }

  @Post('companies/:id/logo')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  uploadLogo(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.config.uploadLogo(req.user, id, file);
  }

  @Post('categories')
  createCategory(@Req() req: RequestWithUser, @Body() dto: CategoryDto) {
    return this.config.createCategory(req.user, dto);
  }

  @Patch('categories/:id')
  updateCategory(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.config.updateCategory(req.user, id, dto);
  }

  @Post('workflows')
  createWorkflow(@Req() req: RequestWithUser, @Body() dto: WorkflowDto) {
    return this.config.createWorkflow(req.user, dto);
  }

  @Patch('workflows/:id')
  updateWorkflow(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WorkflowDto,
  ) {
    return this.config.updateWorkflow(req.user, id, dto);
  }

  @Post('assignments')
  createAssignment(@Req() req: RequestWithUser, @Body() dto: AssignmentDto) {
    return this.config.createAssignment(req.user, dto);
  }

  @Delete('assignments/:id')
  removeAssignment(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.config.removeAssignment(req.user, id);
  }

  @Put('policies')
  savePolicy(@Req() req: RequestWithUser, @Body() dto: PolicyDto) {
    return this.config.savePolicy(req.user, dto);
  }
}

/**
 * Đề nghị tài chính nội bộ. Mọi nhân viên đăng nhập đều dùng được; quyền cụ
 * thể (xem/duyệt/chi tiền/cấu hình) do `FinancialAccessService` quyết định ở
 * từng thao tác, không dựa vào việc ẩn nút trên giao diện.
 */
@Controller('financial-requests')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class FinancialRequestController {
  constructor(
    private readonly requests: FinancialRequestService,
    private readonly ledger: FinancialLedgerService,
    private readonly reports: FinancialReportService,
    private readonly pdf: FinancialPdfService,
    private readonly config: FinancialConfigService,
  ) {}

  // ---- Route tĩnh (phải đứng trước /:id) ----

  @Get('meta')
  meta(@Req() req: RequestWithUser) {
    return this.requests.meta(req.user);
  }

  /** Lưu thông tin nhận tiền của chính mình để điền sẵn cho đề nghị sau. */
  @Put('payee-profile')
  savePayeeProfile(
    @Req() req: RequestWithUser,
    @Body() dto: SavePayeeProfileDto,
  ) {
    return this.requests.savePayeeProfile(req.user, dto);
  }

  @Get('managers')
  managers(
    @Req() req: RequestWithUser,
    @Query('companyId', ParseIntPipe) companyId: number,
  ) {
    return this.requests.eligibleManagers(req.user, companyId);
  }

  @Get('advances/available')
  availableAdvances(
    @Req() req: RequestWithUser,
    @Query() query: AvailableAdvancesQueryDto,
  ) {
    return this.ledger.availableAdvances(req.user, query);
  }

  @Get('salary-advances/check')
  salaryAdvanceCheck(
    @Req() req: RequestWithUser,
    @Query() query: SalaryAdvanceCheckQueryDto,
  ) {
    return this.requests.salaryAdvanceCheck(req.user, query);
  }

  @Get('salary-advances/deductions')
  deductions(@Req() req: RequestWithUser, @Query() query: DeductionQueryDto) {
    return this.ledger.listDeductions(req.user, query);
  }

  @Get('salary-advances/payroll-preview')
  payrollPreview(
    @Req() req: RequestWithUser,
    @Query('employeeId', ParseIntPipe) employeeId: number,
    @Query('year', ParseIntPipe) year: number,
    @Query('month', ParseIntPipe) month: number,
  ) {
    return this.ledger.payrollPreview(req.user, employeeId, year, month);
  }

  @Get('balances')
  balances(@Req() req: RequestWithUser, @Query() query: BalanceQueryDto) {
    return this.ledger.balances(req.user, query);
  }

  @Get('reports/summary')
  summary(
    @Req() req: RequestWithUser,
    @Query() query: FinancialReportQueryDto,
  ) {
    return this.reports.summary(req.user, query);
  }

  @Get('export/excel')
  async exportExcel(
    @Req() req: RequestWithUser,
    @Query() query: FinancialRequestQueryDto,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.reports.exportList(req.user, query);
    res.setHeader('Content-Type', XLSX_MIME);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(fileName, 'attachment'),
    );
    res.send(buffer);
  }

  @Get('delegations/mine')
  myDelegations(@Req() req: RequestWithUser) {
    return this.config.myDelegations(req.user);
  }

  @Post('delegations')
  createDelegation(@Req() req: RequestWithUser, @Body() dto: DelegationDto) {
    return this.config.createDelegation(req.user, dto);
  }

  @Post('delegations/:delegationId/revoke')
  revokeDelegation(
    @Req() req: RequestWithUser,
    @Param('delegationId', ParseIntPipe) delegationId: number,
  ) {
    return this.config.revokeDelegation(req.user, delegationId);
  }

  @Get('companies/:companyId/logo')
  async companyLogo(
    @Param('companyId', ParseIntPipe) companyId: number,
    @Res() res: Response,
  ) {
    const { buffer, mime } = await this.config.companyLogo(companyId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  }

  // ---- Chứng từ ----

  @Get()
  list(@Req() req: RequestWithUser, @Query() query: FinancialRequestQueryDto) {
    return this.requests.list(req.user, query);
  }

  @Post()
  create(@Req() req: RequestWithUser, @Body() dto: CreateFinancialRequestDto) {
    return this.requests.create(req.user, dto);
  }

  @Get(':id')
  detail(@Req() req: RequestWithUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.detail(req.user, id);
  }

  @Patch(':id')
  update(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFinancialRequestDto,
  ) {
    return this.requests.update(req.user, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: RequestWithUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.remove(req.user, id);
  }

  @Post(':id/copy')
  copy(@Req() req: RequestWithUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.copy(req.user, id);
  }

  @Post(':id/submit')
  submit(@Req() req: RequestWithUser, @Param('id', ParseIntPipe) id: number) {
    return this.requests.submit(req.user, id);
  }

  @Post(':id/withdraw')
  withdraw(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: WithdrawDto,
  ) {
    return this.requests.withdraw(req.user, id, dto);
  }

  @Post(':id/approve')
  approve(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveStepDto,
  ) {
    return this.requests.approve(req.user, id, dto);
  }

  @Post(':id/reject')
  reject(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideStepDto,
  ) {
    return this.requests.reject(req.user, id, dto);
  }

  @Post(':id/return')
  returnForChanges(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: DecideStepDto,
  ) {
    return this.requests.returnForChanges(req.user, id, dto);
  }

  @Post(':id/adjust')
  adjust(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdjustItemsDto,
  ) {
    return this.requests.adjust(req.user, id, dto);
  }

  @Post(':id/steps/:stepId/skip')
  skipStep(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('stepId', ParseIntPipe) stepId: number,
    @Body() dto: ReasonDto,
  ) {
    return this.requests.skipStep(req.user, id, stepId, dto);
  }

  @Post(':id/cancel')
  cancel(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReasonDto,
  ) {
    return this.requests.cancel(req.user, id, dto);
  }

  @Get(':id/pdf')
  async downloadPdf(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const { buffer, fileName } = await this.pdf.render(req.user, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      contentDisposition(fileName, query.disposition ?? 'inline'),
    );
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FilesInterceptor('files', ATTACHMENT_MAX_FILES, uploadOptions),
  )
  uploadAttachments(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: UploadAttachmentDto,
  ) {
    return this.requests.uploadAttachments(req.user, id, files, dto);
  }

  @Get(':id/attachments/:attachmentId/file')
  async attachmentFile(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Query() query: ExportQueryDto,
    @Res() res: Response,
  ) {
    const { attachment, stream } = await this.requests.attachmentFile(
      req.user,
      id,
      attachmentId,
    );
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', String(attachment.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(
        attachment.originalName,
        query.disposition ?? 'inline',
      ),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  @Delete(':id/attachments/:attachmentId')
  removeAttachment(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ) {
    return this.requests.removeAttachment(req.user, id, attachmentId);
  }

  @Post(':id/payments')
  recordPayment(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoneyMovementDto,
  ) {
    return this.ledger.recordPayment(id, dto, req.user);
  }

  @Post(':id/payments/:paymentId/void')
  voidPayment(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: ReasonDto,
  ) {
    return this.ledger.voidPayment(id, paymentId, dto, req.user);
  }

  @Post(':id/refunds')
  recordRefund(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MoneyMovementDto,
  ) {
    return this.ledger.recordRefund(id, dto, req.user);
  }

  @Post(':id/refunds/:refundId/void')
  voidRefund(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('refundId', ParseIntPipe) refundId: number,
    @Body() dto: ReasonDto,
  ) {
    return this.ledger.voidRefund(id, refundId, dto, req.user);
  }

  @Post(':id/deductions/:deductionId/confirm')
  confirmDeduction(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('deductionId', ParseIntPipe) deductionId: number,
    @Body() dto: ConfirmDeductionDto,
  ) {
    return this.ledger.confirmDeduction(id, deductionId, dto, req.user);
  }
}
