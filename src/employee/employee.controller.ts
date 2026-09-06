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
} from '@nestjs/common';
import type { Request } from 'express';
import { EmployeeService } from './employee.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { CreateFaceDto } from './dto/create-face.dto';
import { ChangePasswordDto } from './dto/changepassword.dto';
import { EmployeeRegionService } from '../employee-region-school/employee-region.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { AssignRegionDto } from '../employee-region-school/dto/assign-region.dto';
import {
  assertSelfOrEmployeeAdmin,
  EMPLOYEE_ADMIN_ROLES,
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

  @Roles(...EMPLOYEE_ADMIN_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.service.update(id, dto);
  }

  @Get(':id')
  async getEmployee(@Param('id', ParseIntPipe) id: number) {
    return this.service.findById(id);
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
