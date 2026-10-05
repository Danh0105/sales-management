import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import {
  CreateBankAccountDto,
  UpdateBankAccountDto,
} from './dto/bank-account.dto';
import {
  CreateIdentityDocumentDto,
  UpdateIdentityDocumentDto,
} from './dto/identity-document.dto';
import {
  CreateInsuranceProfileDto,
  CreateTaxProfileDto,
  UpdateInsuranceProfileDto,
  UpdateTaxProfileDto,
} from './dto/number-profile.dto';
import { RevealSensitiveDto } from './dto/reveal.dto';
import { HrEmployeeSensitiveService } from './hr-employee-sensitive.service';
import { HR_VALIDATION } from './hr-request';
import type { HrRequest } from './hr-request';

/** Response chứa giá trị đầy đủ: không cache ở trình duyệt / proxy. */
export const NoStore = () =>
  applyDecorators(
    Header('Cache-Control', 'no-store, max-age=0'),
    Header('Pragma', 'no-cache'),
    Header('Expires', '0'),
  );

/**
 * Dữ liệu định danh nhạy cảm. Mặc định chỉ trả dạng che; giá trị đầy đủ chỉ
 * qua POST `.../reveal` (quyền riêng + lý do trong body, không trên URL).
 * Ghi khi crypto không sẵn sàng → 503 HR_CRYPTO_UNAVAILABLE.
 */
@ApiTags('HR — Employee sensitive data')
@ApiBearerAuth()
@Controller('api/hr/v1/employees/:employeeId')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(new ValidationPipe(HR_VALIDATION))
export class HrEmployeeSensitiveController {
  constructor(private readonly service: HrEmployeeSensitiveService) {}

  @Get('identity-documents')
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  listIdentityDocuments(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.listIdentityDocuments(
      req.hrAccess.accountId,
      employeeId,
    );
  }

  @Post('identity-documents')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  createIdentityDocument(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateIdentityDocumentDto,
  ) {
    return this.service.createIdentityDocument(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
    );
  }

  @Patch('identity-documents/:documentId')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  updateIdentityDocument(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: UpdateIdentityDocumentDto,
  ) {
    return this.service.updateIdentityDocument(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      documentId,
      dto,
    );
  }

  @Post('identity-documents/:documentId/reveal')
  @HttpCode(200)
  @NoStore()
  @RequireHrPermission(HrPermission.IDENTITY_REVEAL)
  revealIdentityDocument(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: RevealSensitiveDto,
  ) {
    return this.service.revealIdentityDocument(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      documentId,
      dto.reason,
    );
  }

  @Get('bank-account')
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  getBankAccount(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.getBankAccount(req.hrAccess.accountId, employeeId);
  }

  @Post('bank-account')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  createBankAccount(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.service.createBankAccount(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
    );
  }

  @Patch('bank-account')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  updateBankAccount(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateBankAccountDto,
  ) {
    return this.service.updateBankAccount(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
    );
  }

  @Post('bank-account/reveal')
  @HttpCode(200)
  @NoStore()
  @RequireHrPermission(HrPermission.BANK_REVEAL)
  revealBankAccount(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: RevealSensitiveDto,
  ) {
    return this.service.revealBankAccount(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto.reason,
    );
  }

  @Get('tax-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  getTaxProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.getTaxProfile(req.hrAccess.accountId, employeeId);
  }

  @Post('tax-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  createTaxProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateTaxProfileDto,
  ) {
    return this.service.saveTaxProfile(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto.taxNumber,
    );
  }

  @Patch('tax-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  updateTaxProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateTaxProfileDto,
  ) {
    return this.service.saveTaxProfile(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto.taxNumber,
      dto.version,
    );
  }

  @Get('insurance-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  getInsuranceProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.getInsuranceProfile(req.hrAccess.accountId, employeeId);
  }

  @Post('insurance-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  createInsuranceProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateInsuranceProfileDto,
  ) {
    return this.service.saveInsuranceProfile(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto.socialInsuranceNumber,
    );
  }

  @Patch('insurance-profile')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  updateInsuranceProfile(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateInsuranceProfileDto,
  ) {
    return this.service.saveInsuranceProfile(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto.socialInsuranceNumber,
      dto.version,
    );
  }
}
