import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
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
import {
  HrAuthenticatedOnly,
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import { HR_VALIDATION } from '../employees/hr-request';
import type { HrRequest } from '../employees/hr-request';
import {
  ArchiveHrFileDto,
  RequestHrFileAccessDto,
  UploadHrFileDto,
} from './dto/hr-file.dto';
import {
  HR_FILE_LIST_PERMISSION,
  HR_FILE_UPLOAD_PERMISSION,
  HR_PRIVATE_FILE_MAX_BYTES,
} from './hr-file-policy';
import { HrFileService } from './hr-file.service';
import type { UploadedHrFile } from './hr-file.service';

const PrivateNoStore = () =>
  applyDecorators(
    Header('Cache-Control', 'private, no-store, max-age=0'),
    Header('Pragma', 'no-cache'),
    Header('Expires', '0'),
  );

/**
 * Tài liệu HR riêng tư. Upload vào bộ nhớ (giới hạn kích thước) rồi service
 * ghi kho riêng — không bao giờ ghi vào `uploads/`. Quyền xem nội dung phụ
 * thuộc LOẠI tài liệu nên được kiểm tra ở service (`HrAuthenticatedOnly`).
 */
@ApiTags('HR — Private files')
@ApiBearerAuth()
@Controller('api/hr/v1')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(new ValidationPipe(HR_VALIDATION))
export class HrFileController {
  constructor(private readonly service: HrFileService) {}

  @Post('employees/:employeeId/files')
  @RequireHrPermission(HR_FILE_UPLOAD_PERMISSION)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: HR_PRIVATE_FILE_MAX_BYTES, files: 1, fields: 10 },
    }),
  )
  upload(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UploadHrFileDto,
    @UploadedFile() file: UploadedHrFile | undefined,
  ) {
    return this.service.upload(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
      file,
    );
  }

  @Get('employees/:employeeId/files')
  @RequireHrPermission(HR_FILE_LIST_PERMISSION)
  list(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.list(req.hrAccess.accountId, employeeId);
  }

  /** Quyền phụ thuộc loại tài liệu — kiểm tra đầy đủ trong service. */
  @Post('files/:fileId/access')
  @HttpCode(200)
  @PrivateNoStore()
  @HrAuthenticatedOnly()
  requestAccess(
    @Req() req: HrRequest,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: RequestHrFileAccessDto,
  ) {
    return this.service.requestAccess(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      fileId,
      dto.reason,
    );
  }

  @Post('files/:fileId/archive')
  @HttpCode(200)
  @RequireHrPermission(HR_FILE_UPLOAD_PERMISSION)
  archive(
    @Req() req: HrRequest,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Body() dto: ArchiveHrFileDto,
  ) {
    return this.service.archive(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      fileId,
      dto,
    );
  }
}
