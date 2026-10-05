import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import type { HrRequest } from '../employees/hr-request';
import { contentDisposition } from './hr-file-content';
import { HrFileService } from './hr-file.service';

/**
 * Tải nội dung bằng token có hạn (thay signed URL cho adapter local). Không
 * dùng JWT: link được mở trực tiếp từ trình duyệt; token 256 bit, gắn file,
 * hết hạn sau 5 phút, quyền được kiểm tra lại lúc tải.
 */
@ApiTags('HR — Private files')
@Controller('api/hr/v1/files')
export class HrFileContentController {
  constructor(private readonly service: HrFileService) {}

  @Get(':fileId/content')
  async content(
    @Req() req: HrRequest,
    @Param('fileId', ParseIntPipe) fileId: number,
    @Query('token') token: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    // Không có JWT: người được ghi audit là chủ token (service thay accountId).
    const requestActor = auditActorFromRequest(req);
    const { file, stream } = await this.service.openContent(
      fileId,
      token,
      requestActor,
    );
    res.set({
      'Content-Type': file.mimeType,
      'Content-Length': String(file.sizeBytes),
      'Content-Disposition': contentDisposition(file.originalName),
      'Cache-Control': 'private, no-store, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    });
    return new StreamableFile(stream);
  }
}
