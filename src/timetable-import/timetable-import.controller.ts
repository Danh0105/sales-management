import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Req,
    UploadedFile,
    UseFilters,
    UseGuards,
    UseInterceptors,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    assertCanManageTeaching,
    TEACHING_MANAGE_ROLES,
} from '../teaching/teaching-roles';

import { ChatMessageDto, CreateTimetableDraftDto } from './dto/timetable-import.dto';
import { TimetableImportService } from './timetable-import.service';
import { TimetableUploadFilter } from './timetable-upload.filter';

/** Ảnh chụp thời khoá biểu — một tờ A4 chụp bằng điện thoại hiếm khi quá 15 MB. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Nhập thời khoá biểu bằng cách gửi ảnh chụp, thay cho việc gõ tay từng lớp.
 *
 * Luồng ba bước, và bước ghi dữ liệu tách hẳn khỏi bước đọc ảnh:
 *
 *   1. `POST /timetable-import`            — gửi ảnh, nhận bản nháp + preview
 *   2. `POST /timetable-import/:id/messages` — chat bổ sung phần ảnh không có
 *   3. `POST /timetable-import/:id/commit`   — xác nhận, hệ thống mới tạo dữ liệu
 *
 * Mô hình ngôn ngữ chỉ tham gia bước 1 và 2, và chỉ **đề xuất**. Bước 3 chạy
 * bằng code qua đúng các service tạo lớp/lịch sẵn có, nên một ô đọc sai chỉ là
 * một dòng sai nhìn thấy được trong preview chứ không thành bản ghi sai.
 */
@Controller('timetable-import')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...TEACHING_MANAGE_ROLES)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class TimetableImportController {
    constructor(private readonly service: TimetableImportService) {}

    /**
     * Có ảnh thì đọc ảnh; không có ảnh mà có `message` thì bắt đầu thẳng bằng
     * chat — Nhân sự mô tả lịch cần xếp bằng lời, không bắt buộc chụp ảnh.
     */
    @Post()
    @UseFilters(TimetableUploadFilter)
    @UseInterceptors(
        FileInterceptor('image', { limits: { fileSize: MAX_IMAGE_BYTES } }),
    )
    async create(
        @UploadedFile() image: Express.Multer.File,
        @Body() dto: CreateTimetableDraftDto,
        @Req() req: Request & { user?: { id: number } },
    ) {
        assertCanManageTeaching(req.user as never);
        if (image?.buffer?.length) {
            return this.service.createFromImage(image, req.user!.id);
        }
        if (dto.message) {
            return this.service.createFromText(dto.message, req.user!.id);
        }
        throw new BadRequestException({
            code: 'TIMETABLE_INPUT_REQUIRED',
            message: 'Vui lòng đính kèm ảnh hoặc mô tả lịch dạy cần xếp',
        });
    }

    @Get(':id')
    async get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        assertCanManageTeaching(req.user as never);
        return this.service.get(id);
    }

    @Post(':id/messages')
    async chat(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ChatMessageDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user as never);
        return this.service.chat(id, dto.message);
    }

    @Post(':id/commit')
    async commit(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: Request & { user?: { id: number } },
    ) {
        assertCanManageTeaching(req.user as never);
        return this.service.commit(id, req.user!.id);
    }

    @Post(':id/cancel')
    async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        assertCanManageTeaching(req.user as never);
        return this.service.cancel(id);
    }
}
