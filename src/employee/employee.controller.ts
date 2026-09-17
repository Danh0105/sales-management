import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  ParseIntPipe,
  Patch,
  UseGuards,
  UsePipes,
  ValidationPipe,
  Req,
  UseInterceptors,
  UploadedFile,
  UseFilters,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { AvatarUploadFilter } from '../teaching/avatar-upload.filter';
import { EmployeeService } from './employee.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { CreateFaceDto } from './dto/create-face.dto';
import { ChangePasswordDto } from './dto/changepassword.dto';
import { SetDevRolesDto } from './dto/set-dev-roles.dto';
import { EmployeeRegionService } from '../employee-region-school/employee-region.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AssignRegionDto } from '../employee-region-school/dto/assign-region.dto';
import {
  assertSelfOrEmployeeAdmin,
  EMPLOYEE_ADMIN_ROLES,
  isEmployeeAdmin,
} from './employee-roles';

/**
 * Toàn bộ controller nằm sau `JwtAuthGuard`. Trước đây phần lớn endpoint ở đây
 * không có guard nào: `POST /employees` cho phép người lạ tự tạo tài khoản với
 * `roles` tuỳ ý (kể cả `director`), `PATCH /:id` ghi đè được mọi cột của bất kỳ
 * ai, còn `register-face` thì gắn được khuôn mặt vào tài khoản người khác —
 * mà `POST /face/login` lại đăng nhập bằng khuôn mặt, không cần mật khẩu.
 */
@Controller('employees')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class EmployeeController {
  constructor(
    private readonly service: EmployeeService,
    private readonly employeeRegionService: EmployeeRegionService,
  ) {}

  @Get('by-department-region')
  getByDepartmentAndRegion(
    @Query('departmentId') departmentId: number,
    @Query('regionId') regionId: number,
  ) {
    return this.service.getByDepartmentAndRegion(
      Number(departmentId),
      Number(regionId),
    );
  }

  @Roles(...EMPLOYEE_ADMIN_ROLES)
  @Post()
  create(@Body() dto: CreateEmployeeDto) {
    return this.service.create(dto);
  }

  @Get()
  findAll(@Req() req: Request) {
    return this.service.findAll(req.user!);
  }

  @Get('sales')
  findSalesEmployees(@Req() req: Request) {
    return this.service.findSalesEmployees(req.user!);
  }

  @Get('/getbyid/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Roles(...EMPLOYEE_ADMIN_ROLES)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  @Get('department/:departmentId')
  findByDepartment(@Param('departmentId', ParseIntPipe) departmentId: number) {
    return this.service.findByDepartment(departmentId);
  }

  @Post('assign-region')
  assignRegion(@Body() dto: AssignRegionDto, @Req() req: Request) {
    return this.employeeRegionService.assignRegion(dto, req.user);
  }

  /**
   * Khuôn mặt là một cách đăng nhập, nên chỉ chính chủ (hoặc người quản trị
   * nhân sự đang làm hộ) mới được gắn.
   */
  @Post('register-face')
  async registerFace(@Body() body: CreateFaceDto, @Req() req: Request) {
    assertSelfOrEmployeeAdmin(req.user, Number(body.employeeId));
    return this.service.addFace(body.employeeId, body.descriptor);
  }

  /**
   * Nhận cả JSON lẫn multipart: trang hồ sơ cá nhân gửi multipart khi có
   * ảnh đại diện. Thiếu `FileInterceptor` thì body multipart không được
   * parse, `dto` rỗng và `repo.update(id, {})` nổ 500 — đúng lỗi từng gặp.
   */
  @Patch(':id')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: undefined,
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  @UseFilters(AvatarUploadFilter)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
    @UploadedFile() avatar?: Express.Multer.File,
    @Req() req?: Request,
  ) {
    assertSelfOrEmployeeAdmin(req?.user, id);
    // Tự sửa hồ sơ của mình thì chỉ được đụng phần cá nhân. Quyền, phòng
    // ban, trạng thái, mật khẩu (không cần mật khẩu cũ) vẫn là việc của Nhân
    // sự — nhân viên đổi mật khẩu qua /change-password có kiểm tra mật khẩu cũ.
    if (!isEmployeeAdmin(req?.user)) {
      const restricted = (['password', 'departmentId', 'roles', 'isActive'] as const)
        .filter((key) => dto[key] !== undefined);
      if (restricted.length > 0) {
        throw new ForbiddenException(
          `Bạn không được tự đổi: ${restricted.join(', ')}`,
        );
      }
    }
    return this.service.update(id, dto, avatar);
  }

  @Get(':id')
  async getEmployee(@Param('id', ParseIntPipe) id: number) {
    return this.service.findById(id);
  }

  /**
   * Tài khoản dev tự đổi role cho chính mình để test các luồng theo từng
   * role — không dùng @Roles(): tự kiểm tra ngay trong service, dựa trên
   * role `dev` đang có TRÊN DB (không tin theo JWT), nên endpoint này không
   * mở thêm quyền nào ngoài phạm vi role `dev` đã được cấp sẵn.
   */
  @Patch('me/dev-roles')
  setDevRoles(@Body() dto: SetDevRolesDto, @Req() req: Request) {
    return this.service.setDevRoles(req.user!.id, dto.roles);
  }

  @Patch(':id/change-password')
  changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    assertSelfOrEmployeeAdmin(req.user, id);
    return this.service.changePassword(id, dto);
  }
}
