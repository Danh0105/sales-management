import {
  Body,
  Controller,
  Get,
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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { auditActorFromRequest } from '../audit/hr-audit-actor';
import {
  CreateHrEmployeeDto,
  ListHrEmployeesQuery,
  UpdateHrEmployeeDto,
} from './dto/create-hr-employee.dto';
import { HrEmployeeService } from './hr-employee.service';
import { HR_VALIDATION } from './hr-request';
import type { HrRequest } from './hr-request';

/** Hồ sơ nhân sự cơ bản — không cần tầng mã hoá. */
@ApiTags('HR — Employees')
@ApiBearerAuth()
@Controller('api/hr/v1/employees')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
@UsePipes(new ValidationPipe(HR_VALIDATION))
export class HrEmployeeController {
  constructor(private readonly service: HrEmployeeService) {}

  @Get()
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  list(@Req() req: HrRequest, @Query() query: ListHrEmployeesQuery) {
    return this.service.list(
      req.hrAccess.accountId,
      req.hrAccess.grants,
      query,
    );
  }

  @Get(':employeeId')
  @RequireHrPermission(HrPermission.EMPLOYEE_VIEW)
  get(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
  ) {
    return this.service.get(req.hrAccess.accountId, employeeId);
  }

  @Post()
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  create(@Req() req: HrRequest, @Body() dto: CreateHrEmployeeDto) {
    return this.service.create(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      dto,
    );
  }

  /** Sửa hồ sơ cơ bản — bắt buộc `version`; không sửa mã NV/tài khoản. */
  @Patch(':employeeId')
  @RequireHrPermission(HrPermission.EMPLOYEE_EDIT)
  update(
    @Req() req: HrRequest,
    @Param('employeeId', ParseIntPipe) employeeId: number,
    @Body() dto: UpdateHrEmployeeDto,
  ) {
    return this.service.update(
      req.hrAccess.accountId,
      auditActorFromRequest(req),
      employeeId,
      dto,
    );
  }
}
