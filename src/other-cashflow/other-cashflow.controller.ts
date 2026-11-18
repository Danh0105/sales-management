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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ATTACHMENT_MAX_BYTES } from '../financial-request/financial-request.constants';
import { contentDisposition } from '../financial-request/financial-storage';
import { AuthUser } from '../type/auth-user.type';
import {
  CreateOrderDto,
  CreateOtherCashflowDto,
  ExecuteOrderDto,
  FileQueryDto,
  ListOtherCashflowDto,
  ReasonDto,
  RecordEntryDto,
  ReviewOtherCashflowDto,
  UpdateOtherCashflowDto,
  UploadAttachmentDto,
} from './dto/other-cashflow.dto';
import { ATTACHMENT_MAX_FILES_PER_UPLOAD } from './other-cashflow.constants';
import { OtherCashflowService } from './other-cashflow.service';

type RequestWithUser = { user: AuthUser };

/** Quyền theo vai trò/người lập kiểm tra trong service (other-cashflow-access). */
@Controller('other-cashflows')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class OtherCashflowController {
  constructor(private readonly service: OtherCashflowService) {}

  @Get()
  list(@Req() req: RequestWithUser, @Query() query: ListOtherCashflowDto) {
    return this.service.list(req.user, query);
  }

  @Post()
  create(@Req() req: RequestWithUser, @Body() dto: CreateOtherCashflowDto) {
    return this.service.create(req.user, dto);
  }

  @Get(':id')
  detail(@Req() req: RequestWithUser, @Param('id', ParseIntPipe) id: number) {
    return this.service.detail(req.user, id);
  }

  @Patch(':id')
  update(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateOtherCashflowDto,
  ) {
    return this.service.update(req.user, id, dto);
  }

  @Post(':id/cancel')
  cancel(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReasonDto,
  ) {
    return this.service.cancel(req.user, id, dto);
  }

  @Post(':id/review')
  review(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReviewOtherCashflowDto,
  ) {
    return this.service.review(req.user, id, dto);
  }

  @Post(':id/entries')
  recordEntry(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RecordEntryDto,
  ) {
    return this.service.recordEntry(req.user, id, dto);
  }

  @Post(':id/entries/:entryId/void')
  voidEntry(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('entryId', ParseIntPipe) entryId: number,
    @Body() dto: ReasonDto,
  ) {
    return this.service.voidEntry(req.user, id, entryId, dto);
  }

  /** Đơn Thương mại — kế toán công nợ lập phiếu thu / lệnh chi. */
  @Post(':id/orders')
  createOrder(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateOrderDto,
  ) {
    return this.service.createOrder(req.user, id, dto);
  }

  @Post(':id/orders/:orderId/cancel')
  cancelOrder(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: ReasonDto,
  ) {
    return this.service.cancelOrder(req.user, id, orderId, dto);
  }

  /** Thủ quỹ thu/chi theo phiếu. */
  @Post(':id/orders/:orderId/execute')
  executeOrder(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('orderId', ParseIntPipe) orderId: number,
    @Body() dto: ExecuteOrderDto,
  ) {
    return this.service.executeOrder(req.user, id, orderId, dto);
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FilesInterceptor('files', ATTACHMENT_MAX_FILES_PER_UPLOAD, {
      storage: memoryStorage(),
      limits: {
        fileSize: ATTACHMENT_MAX_BYTES,
        files: ATTACHMENT_MAX_FILES_PER_UPLOAD,
      },
    }),
  )
  uploadAttachments(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() dto: UploadAttachmentDto,
  ) {
    return this.service.uploadAttachments(req.user, id, files, dto);
  }

  @Delete(':id/attachments/:attachmentId')
  removeAttachment(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
  ) {
    return this.service.removeAttachment(req.user, id, attachmentId);
  }

  @Get(':id/attachments/:attachmentId/file')
  async attachmentFile(
    @Req() req: RequestWithUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Query() query: FileQueryDto,
    @Res() res: Response,
  ) {
    const { attachment, stream } = await this.service.attachmentFile(
      req.user,
      id,
      attachmentId,
    );
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', String(attachment.sizeBytes));
    res.setHeader(
      'Content-Disposition',
      contentDisposition(attachment.originalName, query.disposition ?? 'inline'),
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
