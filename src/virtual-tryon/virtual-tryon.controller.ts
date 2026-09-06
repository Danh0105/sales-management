import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { VirtualTryOnService, TryOnAccess } from './virtual-tryon.service';
import { VirtualTryOnRateLimitService } from './virtual-tryon-rate-limit.service';
import {
  CreateVirtualTryOnDto,
  QueryVirtualTryOnDto,
} from './dto/virtual-tryon.dto';
import { TRYON_MAX_FILE_BYTES } from './virtual-tryon.constants';
import { decodeOptionalUser } from './optional-user.util';

/** Ai được xem/xoá job của người khác. */
const TRYON_ADMIN_ROLES = ['director', 'director_la', 'nhansu', 'saleadmin'];

/**
 * Nhận file vào RAM chứ không ghi thẳng xuống đĩa: ảnh còn phải qua bước kiểm
 * định + chuẩn hoá (`VirtualTryOnStorageService`) rồi mới lưu, ghi trước sẽ để
 * lại rác mỗi lần ảnh bị từ chối.
 */
const tryOnUpload = FileFieldsInterceptor(
  [
    { name: 'person', maxCount: 1 },
    { name: 'garment', maxCount: 1 },
  ],
  {
    storage: memoryStorage(),
    limits: { fileSize: TRYON_MAX_FILE_BYTES, files: 2 },
  },
);

/**
 * Thử đồ ảo — **mở công khai**, không bắt đăng nhập.
 *
 * Vì mỗi lượt tạo ảnh tốn tiền thật ở OpenAI nên khách vãng lai bị giới hạn số
 * lượt theo IP (`VirtualTryOnRateLimitService`); người đã đăng nhập được miễn.
 * Job của khách vãng lai được cấp `publicToken` — không có token thì không
 * xem/xoá được job của người khác dù biết id.
 */
@Controller('virtual-tryon')
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class VirtualTryOnController {
  constructor(
    private readonly service: VirtualTryOnService,
    private readonly rateLimit: VirtualTryOnRateLimitService,
  ) {}

  /**
   * Tạo yêu cầu thử đồ: multipart với 2 file `person` + `garment`.
   * Trả về job PENDING; khách chưa đăng nhập nhận kèm `publicToken` để hỏi lại
   * kết quả qua `GET /virtual-tryon/:id?token=...`.
   */
  @Post()
  @UseInterceptors(tryOnUpload)
  async create(
    @UploadedFiles()
    files: { person?: Express.Multer.File[]; garment?: Express.Multer.File[] },
    @Body() dto: CreateVirtualTryOnDto,
    @Req() req: Request,
  ) {
    const user = decodeOptionalUser(req);
    const person = files?.person?.[0];
    const garment = files?.garment?.[0];

    if (!person || !garment) {
      throw new BadRequestException(
        'Cần đủ 2 ảnh: `person` (người mặc) và `garment` (trang phục)',
      );
    }

    this.rateLimit.consume(req, !!user);

    try {
      return await this.service.create({ person, garment }, dto, user?.id);
    } catch (error) {
      // Ảnh hỏng / lỗi hệ thống thì không tính vào hạn mức của khách.
      this.rateLimit.refund(req, !!user);
      throw error;
    }
  }

  /**
   * Danh sách job — chỉ cho tài khoản đã đăng nhập. Cố ý KHÔNG mở công khai:
   * job chứa ảnh chân dung, mở ra là ai cũng duyệt được ảnh của người khác.
   */
  @Get()
  @UseGuards(JwtAuthGuard)
  findAll(@Query() query: QueryVirtualTryOnDto, @Req() req: Request) {
    const scoped = this.canViewAll(req)
      ? query
      : { ...query, createdBy: req.user!.id };

    return this.service.findAll(scoped);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.findOne(id, this.accessOf(req, token));
  }

  @Delete(':id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('token') token: string | undefined,
    @Req() req: Request,
  ) {
    return this.service.remove(id, this.accessOf(req, token));
  }

  private accessOf(req: Request, token?: string): TryOnAccess {
    const user = decodeOptionalUser(req);
    return {
      viewerId: user?.id ?? null,
      canViewAll: this.canViewAll(req),
      token: token ?? null,
    };
  }

  private canViewAll(req: Request): boolean {
    const roles = req.user?.roles ?? decodeOptionalUser(req)?.roles ?? [];
    return roles.some((role) => TRYON_ADMIN_ROLES.includes(role));
  }
}
