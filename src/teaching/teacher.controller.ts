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
  UploadedFile,
  UseFilters,
  UseInterceptors,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { TeacherService } from './teacher.service';
import {
  CreateTeacherDto,
  QueryTeachersDto,
  UpdateTeacherDto,
  ResetTeacherPasswordDto,
} from './dto/teacher.dto';
import {
  assertCanManageTeaching,
  assertCanSetTeachingRates,
  canApproveTeacherAccount,
  requiresTeacherAccountApproval,
  TEACHER_ACCOUNT_APPROVE_ROLES,
  TEACHER_ROLES,
  TEACHING_MANAGE_ROLES,
  TEACHING_VIEW_ROLES,
  HR_ROLE,
} from './teaching-roles';
import {
  UpdateTeacherProfileDto,
  TeacherProfileResponseDto,
} from './dto/teacher-profile.dto';
import { AvatarUploadFilter } from './avatar-upload.filter';
import { TeacherMatchingService } from './teacher-matching.service';
import { FindTeacherCandidatesDto } from './dto/teacher-matching.dto';
import {
  CaptureTeacherLocationDto,
  QueryTeacherLocationChangesDto,
  ReviewTeacherLocationDto,
} from './dto/teacher-location.dto';
import {
  QueryTeacherAccountRequestsDto,
  ReviewTeacherAccountRequestDto,
} from './dto/teacher-account-request.dto';

@Controller('teachers')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }),
)
export class TeacherController {
  constructor(
    private readonly service: TeacherService,
    private readonly matching: TeacherMatchingService,
  ) {}

  /** Hồ sơ giáo viên của chính tài khoản đang đăng nhập. */
  @Roles(...TEACHER_ROLES, ...TEACHING_VIEW_ROLES)
  @Get('me')
  @ApiBearerAuth()
  @ApiOkResponse({ type: TeacherProfileResponseDto })
  findMine(@Req() req: Request) {
    return this.service.findByEmployeeId(req.user!.id);
  }

  @Roles(...TEACHER_ROLES)
  @Patch('me')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: undefined,
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  @UseFilters(AvatarUploadFilter)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Giáo viên cập nhật hồ sơ của chính mình' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UpdateTeacherProfileDto })
  @ApiOkResponse({ type: TeacherProfileResponseDto })
  @ApiResponse({ status: 400, description: 'Dữ liệu không hợp lệ' })
  @ApiResponse({ status: 401, description: 'JWT không hợp lệ hoặc hết hạn' })
  @ApiResponse({ status: 403, description: 'Không phải giáo viên' })
  @ApiResponse({ status: 404, description: 'Chưa liên kết hồ sơ giáo viên' })
  @ApiResponse({ status: 409, description: 'Số điện thoại/email đã tồn tại' })
  @ApiResponse({ status: 413, description: 'Ảnh vượt quá 10 MB' })
  @ApiResponse({ status: 415, description: 'Định dạng ảnh không hỗ trợ' })
  @ApiResponse({ status: 422, description: 'Ảnh hỏng hoặc không thể xử lý' })
  updateMine(
    @Req() req: Request,
    @Body(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: UpdateTeacherProfileDto,
    @UploadedFile() avatar?: Express.Multer.File,
  ) {
    return this.service.updateMine(req.user!.id, dto, avatar);
  }

  @Roles(...TEACHER_ROLES)
  @Post('me/location')
  @ApiOperation({
    summary: 'Giáo viên gửi vị trí hiện tại; thay đổi cần được duyệt',
  })
  captureMyLocation(
    @Req() req: Request,
    @Body() dto: CaptureTeacherLocationDto,
  ) {
    return this.service.captureMyLocation(req.user!.id, dto);
  }

  @Roles(...TEACHING_MANAGE_ROLES)
  @Get('location-change-requests')
  findLocationChanges(@Query() query: QueryTeacherLocationChangesDto) {
    return this.service.findLocationChanges(query);
  }

  @Roles(...TEACHING_MANAGE_ROLES)
  @Patch('location-change-requests/:id/approve')
  approveLocationChange(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Body() dto: ReviewTeacherLocationDto,
  ) {
    return this.service.reviewLocationChange(id, req.user!.id, true, dto);
  }

  @Roles(...TEACHING_MANAGE_ROLES)
  @Patch('location-change-requests/:id/reject')
  rejectLocationChange(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Body() dto: ReviewTeacherLocationDto,
  ) {
    return this.service.reviewLocationChange(id, req.user!.id, false, dto);
  }

  /**
   * Hồ sơ mở tài khoản giáo viên đang chờ Nhân sự xác nhận.
   *
   * Khai báo trước `@Get(':id')` vì Nest khớp route theo thứ tự — để sau thì
   * "account-requests" bị nuốt vào `:id` và trả 400.
   */
  @Roles(...TEACHING_MANAGE_ROLES)
  @Get('account-requests')
  @ApiOperation({
    summary:
      'Danh sách đề nghị mở tài khoản giáo viên (Giáo vụ chỉ thấy của mình)',
  })
  findAccountRequests(
    @Query() query: QueryTeacherAccountRequestsDto,
    @Req() req: Request,
  ) {
    return this.service.findAccountRequests(
      query,
      req.user!.id,
      canApproveTeacherAccount(req.user),
    );
  }

  @Roles(...TEACHING_MANAGE_ROLES)
  @Get('account-requests/:id')
  findAccountRequest(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    return this.service.findAccountRequest(
      id,
      req.user!.id,
      canApproveTeacherAccount(req.user),
    );
  }

  @Roles(...TEACHER_ACCOUNT_APPROVE_ROLES)
  @Patch('account-requests/:id/approve')
  @ApiOperation({
    summary: 'Nhân sự xác nhận — tài khoản giáo viên được tạo ở bước này',
  })
  @ApiResponse({
    status: 409,
    description: 'Đề nghị đã xử lý, hoặc số điện thoại/email đã bị chiếm',
  })
  approveAccountRequest(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Body() dto: ReviewTeacherAccountRequestDto,
  ) {
    return this.service.reviewAccountRequest(id, req.user!.id, true, dto);
  }

  @Roles(...TEACHER_ACCOUNT_APPROVE_ROLES)
  @Patch('account-requests/:id/reject')
  @ApiOperation({ summary: 'Nhân sự từ chối — không tạo tài khoản nào' })
  rejectAccountRequest(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
    @Body() dto: ReviewTeacherAccountRequestDto,
  ) {
    return this.service.reviewAccountRequest(id, req.user!.id, false, dto);
  }

  @Roles(...TEACHING_VIEW_ROLES)
  @Get()
  findAll(@Query() query: QueryTeachersDto) {
    return this.service.findAll(query);
  }

  /**
   * Xếp hạng giáo viên cho một ô lịch theo tiêu chí đã khai trong hồ sơ.
   *
   * Khai báo **trước** `@Get(':id')` vì Nest khớp route theo thứ tự — để sau thì
   * "matching-coverage" bị nuốt vào `:id` và trả 400.
   */
  @Roles(...TEACHING_VIEW_ROLES)
  @Get('matching-coverage')
  matchingCoverage() {
    return this.matching.coverage();
  }

  /**
   * Không nhận `scheduleId` mà nhận thẳng mô tả ô lịch: luồng nhập thời khoá
   * biểu từ ảnh cần xếp hạng giáo viên trước khi tạo bất kỳ bản ghi nào.
   */
  @Roles(...TEACHING_VIEW_ROLES)
  @Post('candidates')
  findCandidates(@Body() dto: FindTeacherCandidatesDto) {
    return this.matching.findCandidates(dto);
  }

  @Roles(...TEACHING_VIEW_ROLES)
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  /**
   * Nhân sự tạo là có tài khoản ngay; Giáo vụ tạo thì chỉ ra một hồ sơ chờ
   * duyệt (`{ status: 'pending', requestId }`) và Nhân sự nhận được thông báo.
   */
  @Roles(...TEACHING_MANAGE_ROLES)
  @Post()
  @ApiOperation({
    summary:
      'Tạo giáo viên. Giáo vụ gửi thì tài khoản chỉ được tạo sau khi Nhân sự xác nhận',
  })
  create(@Body() dto: CreateTeacherDto, @Req() req: Request) {
    assertCanManageTeaching(req.user);
    assertCanSetTeachingRates(req.user, dto, ['defaultRatePerPeriod']);

    if (requiresTeacherAccountApproval(req.user)) {
      return this.service.requestCreate(dto, req.user!.id);
    }
    return this.service.create(dto);
  }

  /**
   * Gửi kèm `password` = cấp tài khoản đăng nhập cho hồ sơ giáo viên chưa có.
   * Việc này cũng phải qua Nhân sự duyệt khi người gửi là Giáo vụ — nếu không
   * thì chỉ cần sửa hồ sơ cũ là mở được tài khoản, vòng qua bước duyệt.
   */
  @Roles(...TEACHING_MANAGE_ROLES)
  @Patch(':id')
  @ApiOperation({
    summary:
      'Sửa hồ sơ giáo viên; gửi kèm password để cấp tài khoản đăng nhập cho hồ sơ chưa có',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTeacherDto,
    @Req() req: Request,
  ) {
    assertCanManageTeaching(req.user);
    assertCanSetTeachingRates(req.user, dto, ['defaultRatePerPeriod']);

    const teacher = await this.service.update(id, dto, req.user!.id);
    if (!dto.password) return teacher;

    // Hồ sơ đã lưu xong ở trên; phần cấp tài khoản đi tiếp theo luồng của nó.
    return requiresTeacherAccountApproval(req.user)
      ? this.service.requestAccountForTeacher(id, dto, req.user!.id)
      : this.service.createAccountForTeacher(id, dto);
  }

  @Roles(...TEACHING_MANAGE_ROLES)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    assertCanManageTeaching(req.user);
    return this.service.remove(id);
  }

  @Roles(HR_ROLE, 'director')
  @Patch(':id/reset-password')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResetTeacherPasswordDto,
  ) {
    return this.service.resetPassword(id, dto.password ?? '123456');
  }
}
