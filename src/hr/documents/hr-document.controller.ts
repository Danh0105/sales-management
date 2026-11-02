import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import { HR_VALIDATION } from '../employees/hr-request';
import type { HrRequest } from '../employees/hr-request';
import { HR_PRIVATE_FILE_MAX_BYTES } from '../files/hr-file-policy';
import type { UploadedHrFile } from '../files/hr-file.service';
import {
  AddDocumentVersionDto,
  ArchiveDocumentDto,
  CreateDocumentDto,
  ExpiringDocumentsQuery,
  ListDocumentsQuery,
  UpdateDocumentDto,
} from './dto/document.dto';
import { HrDocumentService } from './hr-document.service';

/** Upload vào bộ nhớ (giới hạn kích thước như 0.4C) rồi service ghi kho riêng qua HrFileService. */
const SingleFile = () =>
  UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: HR_PRIVATE_FILE_MAX_BYTES, files: 1, fields: 10 },
    }),
  );

/**
 * Hồ sơ tài liệu nhân viên (Phase 1.3). Xem/tải nội dung KHÔNG ở đây — dùng
 * `POST files/:id/access` → `GET files/:id/content` của 0.4C.
 */
@ApiTags('HR — Documents')
@ApiBearerAuth()
@Controller('api/hr/v1')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(new ValidationPipe(HR_VALIDATION))
export class HrDocumentController {
  constructor(private readonly service: HrDocumentService) {}

  @Get('employees/:employeeId/documents')
  @RequireHrPermission(HrPermission.DOCUMENT_VIEW)
  list(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Query() query: ListDocumentsQuery,
  ) {
    return this.service.list(req.hrAccess.accountId, employeeId, query);
  }

  @Post('employees/:employeeId/documents')
  @RequireHrPermission(HrPermission.DOCUMENT_MANAGE)
  @ApiConsumes('multipart/form-data')
  @SingleFile()
  create(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: CreateDocumentDto,
    @UploadedFile() file: UploadedHrFile | undefined,
  ) {
    return this.service.create(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
      file,
    );
  }

  @Get('documents/expiring')
  @RequireHrPermission(HrPermission.DOCUMENT_VIEW)
  expiring(@Req() req: HrRequest, @Query() query: ExpiringDocumentsQuery) {
    return this.service.expiring(
      req.hrAccess.accountId,
      req.hrAccess.grants,
      query,
    );
  }

  @Post('documents/:documentId/versions')
  @RequireHrPermission(HrPermission.DOCUMENT_MANAGE)
  @ApiConsumes('multipart/form-data')
  @SingleFile()
  addVersion(
    @Req() req: HrRequest,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: AddDocumentVersionDto,
    @UploadedFile() file: UploadedHrFile | undefined,
  ) {
    return this.service.addVersion(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      documentId,
      dto,
      file,
    );
  }

  @Patch('documents/:documentId')
  @RequireHrPermission(HrPermission.DOCUMENT_MANAGE)
  update(
    @Req() req: HrRequest,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.service.update(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      documentId,
      dto,
    );
  }

  @Post('documents/:documentId/archive')
  @RequireHrPermission(HrPermission.DOCUMENT_MANAGE)
  archive(
    @Req() req: HrRequest,
    @Param('documentId', ParseIntPipe) documentId: number,
    @Body() dto: ArchiveDocumentDto,
  ) {
    return this.service.archive(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      documentId,
      dto,
    );
  }
}
