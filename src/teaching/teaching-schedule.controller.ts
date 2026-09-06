import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { TeachingScheduleService } from './teaching-schedule.service';
import { TeachingBulkService } from './teaching-bulk.service';
import {
    ConfirmTeachingScheduleDto,
    CreateTeachingScheduleDto,
    GenerateSessionsDto,
    QueryTeachingSchedulesDto,
    UpdateTeachingScheduleDto,
} from './dto/teaching-schedule.dto';
import { BulkCreateSchedulesDto } from './dto/teaching-bulk.dto';
import {
    assertCanManageTeaching,
    resolveTeachingScope,
    TEACHER_ROLES,
    TEACHING_MANAGE_ROLES,
    TEACHING_OWN_SCHOOLS_ROLES,
    TEACHING_VIEW_ROLES,
} from './teaching-roles';

@Controller('teaching-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class TeachingScheduleController {
    constructor(
        private readonly service: TeachingScheduleService,
        private readonly bulkService: TeachingBulkService,
    ) { }

    /**
     * Danh sách mẫu lịch tuần. Kinh doanh cũng gọi được nhưng phạm vi bị thu hẹp
     * về trường mình phụ trách — suy ra từ token, không nhận từ query.
     */
    @Roles(...TEACHING_VIEW_ROLES, ...TEACHING_OWN_SCHOOLS_ROLES)
    @Get()
    findAll(@Query() query: QueryTeachingSchedulesDto, @Req() req: Request) {
        return this.service.findAll(query, resolveTeachingScope(req.user));
    }

    /**
     * Mẫu lịch tuần của chính giáo viên đang đăng nhập.
     * Phải khai trước ':id', nếu không "me" rơi vào route theo id.
     * teacherId lấy từ token, tham số teacherId gửi lên bị bỏ qua.
     */
    @Roles(...TEACHER_ROLES)
    @Get('me')
    findMine(@Query() query: QueryTeachingSchedulesDto, @Req() req: Request) {
        return this.service.findMine(req.user!.id, query);
    }

    @Roles(...TEACHING_VIEW_ROLES)
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Post()
    create(@Body() dto: CreateTeachingScheduleDto, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.create(dto);
    }

    /**
     * Áp một môn cho nhiều lớp của nhiều trường trong một lần gọi.
     * Trả 200 kèm kết quả từng lớp — lớp lỗi bị bỏ qua, phần còn lại vẫn tạo.
     */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post('bulk')
    @HttpCode(200)
    createBulk(@Body() dto: BulkCreateSchedulesDto, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.bulkService.createSchedules(dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateTeachingScheduleDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        return this.service.update(id, dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.remove(id);
    }

    /** Giáo viên xác nhận hoặc từ chối mẫu lịch được giao. */
    @Roles(...TEACHER_ROLES)
    @Patch(':id/confirmation')
    confirm(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmTeachingScheduleDto,
        @Req() req: Request,
    ) {
        return this.service.confirm(id, req.user!.id, dto);
    }

    /** Sinh buổi dạy cụ thể từ mẫu lặp — chạy lại không nhân đôi buổi. */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post(':id/generate-sessions')
    generateSessions(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: GenerateSessionsDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        return this.service.generateSessions(id, dto);
    }
}
