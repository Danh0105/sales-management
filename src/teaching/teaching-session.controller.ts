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
    UploadedFile,
    UploadedFiles,
    UseFilters,
    UseGuards,
    UseInterceptors,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { TeachingSessionService } from './teaching-session.service';
import { TeachingBulkService } from './teaching-bulk.service';
import {
    BulkCheckAttendanceDto,
    ApplyTeachingSessionDto,
    AssignTeachingSessionDto,
    CheckAttendanceDto,
    CheckinTeachingSessionDto,
    CheckoutTeachingSessionDto,
    ConfirmTeachingSessionDto,
    CreateTeachingSessionDto,
    DeclineTeachingSessionDto,
    QueryAttendanceSummaryDto,
    QueryTeachingSessionsDto,
    NotifyTeachingScheduleDto,
    SubmitLessonDto,
    UpdateTeachingSessionDto,
} from './dto/teaching-session.dto';
import { BulkCreateSessionsDto } from './dto/teaching-bulk.dto';
import {
    assertCanManageTeaching,
  assertCanSetTeachingRates,
    TEACHER_ROLES,
    TEACHING_MANAGE_ROLES,
    TEACHING_OWN_SCHOOLS_ROLES,
    TEACHING_VIEW_ROLES,
    resolveTeachingScope,
} from './teaching-roles';
import { LessonImageUploadFilter } from './lesson-image-upload.filter';
import { LessonImageLibraryService } from './lesson-image-library.service';
import { QueryLessonImagesDto } from './dto/query-lesson-images.dto';

@Controller('teaching-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class TeachingSessionController {
    constructor(
        private readonly service: TeachingSessionService,
        private readonly bulkService: TeachingBulkService,
        private readonly lessonImageLibrary: LessonImageLibraryService,
    ) { }

    /**
     * Tạo tiết cho nhiều lớp × nhiều ngày trong một lần gọi.
     * Không có teacherId thì tiết ở trạng thái OPEN cho giáo viên đăng ký.
     */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post('bulk')
    @HttpCode(200)
    createBulk(@Body() dto: BulkCreateSessionsDto, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.bulkService.createSessions(dto);
    }

    /**
     * Buổi dạy hôm nay sắp/đã tới giờ mà giáo viên chưa check-in.
     * Dùng cho banner cảnh báo trên màn Chấm công của Giáo vụ / Nhân sự.
     */
    @Roles(...TEACHING_VIEW_ROLES)
    @Get('checkin-alerts')
    findCheckinAlerts() {
        return this.service.findCheckinAlerts();
    }

    /**
     * Chạy tay job báo động — để kiểm tra cấu hình push/thông báo mà không phải
     * ngồi chờ đúng khung giờ. Job tự động vẫn chạy mỗi phút như thường.
     */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post('checkin-alerts/run')
    @HttpCode(200)
    runCheckinAlerts(@Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.runMissingCheckinAlerts();
    }

    /**
     * Chạy tay job nhắc xác nhận lịch dạy (còn PENDING, sắp tới trong 1 ngày) —
     * để kiểm tra cấu hình push/thông báo mà không phải chờ đúng khung giờ.
     * Job tự động vẫn chạy mỗi 30 phút như thường.
     */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post('confirmation-alerts/run')
    @HttpCode(200)
    runConfirmationAlerts(@Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.runScheduleConfirmationAlerts();
    }

    @Roles('nhansu')
    @Post('notify-schedule')
    @HttpCode(200)
    notifySchedule(
        @Body() dto: NotifyTeachingScheduleDto,
        @Req() req: Request,
    ) {
        return this.service.notifySchedule(dto, req.user!.id);
    }

    /**
     * Lịch dạy của chính giáo viên đang đăng nhập.
     * teacherId lấy từ token, tham số teacherId gửi lên bị bỏ qua.
     */
    @Roles(...TEACHER_ROLES)
    @Get('me')
    findMine(@Query() query: QueryTeachingSessionsDto, @Req() req: Request) {
        return this.service.findMine(req.user!.id, query);
    }

    @Roles(...TEACHER_ROLES)
    @Get('open')
    findOpen(@Query() query: QueryTeachingSessionsDto, @Req() req: Request) {
        return this.service.findOpen(req.user!.id, query);
    }

    @Roles(...TEACHER_ROLES)
    @Post(':id/applications')
    applyForSession(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ApplyTeachingSessionDto,
        @Req() req: Request,
    ) {
        return this.service.applyForSession(id, dto, req.user!.id);
    }

    @Roles(...TEACHER_ROLES)
    @Delete(':id/applications/me')
    withdrawApplication(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: Request,
    ) {
        return this.service.withdrawApplication(id, req.user!.id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Get(':id/suggestions')
    suggestions(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.suggestions(id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id/assign')
    assignTeacher(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: AssignTeachingSessionDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        return this.service.assignTeacher(id, dto);
    }

    /** Giáo viên xác nhận hoặc từ chối buổi dạy được giao. */
    @Roles(...TEACHER_ROLES)
    @Patch(':id/confirmation')
    confirmSession(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ConfirmTeachingSessionDto,
        @Req() req: Request,
    ) {
        return this.service.confirmSession(id, req.user!.id, dto);
    }

    /** Giáo viên xin rút khỏi buổi đã phân công vì có việc đột xuất. */
    @Roles(...TEACHER_ROLES)
    @Post(':id/decline')
    declineSession(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: DeclineTeachingSessionDto,
        @Req() req: Request,
    ) {
        return this.service.declineSession(id, req.user!.id, dto);
    }

    @Roles(...TEACHER_ROLES)
    @Post(':id/checkin')
    @HttpCode(200)
    @UseInterceptors(FileInterceptor('image', {
        storage: undefined,
        limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }))
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: {
        type: 'object',
        required: ['latitude', 'longitude', 'image'],
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
            image: { type: 'string', format: 'binary' },
        },
    } })
    checkin(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CheckinTeachingSessionDto,
        @Req() req: Request,
        @UploadedFile() image: Express.Multer.File,
    ) {
        return this.service.checkin(id, dto, req.user!.id, image);
    }

    @Roles(...TEACHER_ROLES)
    @Post(':id/checkout')
    @HttpCode(200)
    // Multer vẫn cần để parse các field text multipart; checkout không nhận file.
    @UseInterceptors(FileInterceptor('_unused'))
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Check-out block buổi dạy bằng GPS' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: {
        type: 'object',
        required: ['latitude', 'longitude'],
        properties: {
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
            accuracy: { type: 'integer', minimum: 0, nullable: true },
        },
    } })
    @ApiResponse({
        status: 200,
        description: 'Check-out thành công',
        schema: {
            type: 'object',
            properties: {
                id: { type: 'integer', example: 123 },
                checkoutAt: { type: 'string', format: 'date-time' },
                checkoutLatitude: { type: 'number', example: 10.7769 },
                checkoutLongitude: { type: 'number', example: 106.7009 },
                checkoutAccuracy: { type: 'integer', nullable: true, example: 18 },
                lessonName: { type: 'string' },
                lessonEvaluation: { type: 'string' },
                lessonImages: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', example: '0f1b8c2e-8f4a-4a1e-9c1b-1a2b3c4d5e6f' },
                            url: { type: 'string', example: '/uploads/lesson-images/0f1b8c2e-8f4a-4a1e-9c1b-1a2b3c4d5e6f.webp' },
                            name: { type: 'string' },
                            mimeType: { type: 'string', example: 'image/webp' },
                            size: { type: 'integer', nullable: true, example: 184320 },
                            sortOrder: { type: 'integer', example: 0 },
                        },
                    },
                },
            },
        },
    })
    @ApiResponse({ status: 400, description: 'Form hoặc trạng thái buổi không hợp lệ' })
    @ApiResponse({ status: 413, description: 'Ảnh vượt quá 10 MB' })
    @ApiResponse({ status: 415, description: 'Định dạng ảnh không hỗ trợ' })
    @ApiResponse({ status: 422, description: 'Ảnh hỏng hoặc không thể xử lý' })
    checkout(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CheckoutTeachingSessionDto,
        @Req() req: Request,
    ) {
        const header = req.headers['x-request-id'];
        const requestId = Array.isArray(header) ? header[0] : header;
        return this.service.checkout(id, dto, req.user!.id, [], requestId);
    }

    /**
     * Báo giảng sau khi block đã chấm công, chậm nhất 08:00 hôm sau.
     */
    @Roles(...TEACHER_ROLES)
    @Post(':id/lesson')
    @HttpCode(200)
    @UseInterceptors(FilesInterceptor('images', 10, {
        storage: undefined,
        limits: { fileSize: 50 * 1024 * 1024, files: 10 },
    }))
    @UseFilters(LessonImageUploadFilter)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Báo giảng cho một tiết đã chấm công' })
    @ApiConsumes('multipart/form-data')
    @ApiBody({ schema: {
        type: 'object',
        required: ['lessonName', 'lessonEvaluation', 'actualStudentCount', 'images'],
        properties: {
            lessonName: { type: 'string', minLength: 1, maxLength: 255 },
            lessonEvaluation: { type: 'string', minLength: 1, maxLength: 2000 },
            actualStudentCount: { type: 'integer', minimum: 0 },
            images: { type: 'array', maxItems: 10, items: { type: 'string', format: 'binary' } },
        },
    } })
    @ApiResponse({ status: 400, description: 'Chưa chấm công hoặc đã quá hạn báo giảng' })
    @ApiResponse({ status: 413, description: 'Minh chứng vượt quá 50 MB' })
    @ApiResponse({ status: 415, description: 'Định dạng ảnh không hỗ trợ' })
    @ApiResponse({ status: 422, description: 'Ảnh hỏng hoặc không thể xử lý' })
    submitLesson(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: SubmitLessonDto,
        @Req() req: Request,
        @UploadedFiles() images: Express.Multer.File[] = [],
    ) {
        const header = req.headers['x-request-id'];
        const requestId = Array.isArray(header) ? header[0] : header;
        return this.service.submitLesson(id, dto, req.user!.id, images, requestId);
    }

    /** Bảng tổng hợp chấm công theo giáo viên. */
    @Roles(...TEACHING_VIEW_ROLES)
    @Get('attendance/summary')
    attendanceSummary(@Query() query: QueryAttendanceSummaryDto) {
        return this.service.attendanceSummary(query);
    }

    /** Thư viện ảnh báo giảng, phân trang theo từng ảnh trong SQL. */
    @Roles(...TEACHING_VIEW_ROLES, ...TEACHER_ROLES, ...TEACHING_OWN_SCHOOLS_ROLES)
    @Get('lesson-images')
    lessonImages(@Query() query: QueryLessonImagesDto, @Req() req: Request) {
        return this.lessonImageLibrary.findAll(query, resolveTeachingScope(req.user));
    }

    @Roles(...TEACHING_VIEW_ROLES)
    @Get()
    findAll(@Query() query: QueryTeachingSessionsDto) {
        return this.service.findAll(query);
    }

    @Roles(...TEACHING_VIEW_ROLES)
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }

    /** Tạo buổi lẻ hoặc buổi dạy bù. */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Post()
    create(@Body() dto: CreateTeachingSessionDto, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.create(dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateTeachingSessionDto,
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

    /** Chấm công nhiều buổi cùng lúc — đặt trước :id/attendance để khớp route. */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch('attendance/bulk')
    bulkCheckAttendance(
        @Body() dto: BulkCheckAttendanceDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        assertCanSetTeachingRates(req.user, dto);
        return this.service.bulkCheckAttendance(dto, req.user!.id);
    }

    /** Chấm công một buổi. */
    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id/attendance')
    checkAttendance(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CheckAttendanceDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        assertCanSetTeachingRates(req.user, dto);
        return this.service.checkAttendance(id, dto, req.user!.id);
    }
}
