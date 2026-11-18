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
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { CASHFLOW_TEACHER_PAY_ROLES } from '../school-expenses/cashflow-roles';
import { SchoolTeachersService } from './school-teachers.service';

/** Danh sách giáo viên của trường — lương từng người: không gồm Sales Admin. */
@Controller('school-teachers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_TEACHER_PAY_ROLES)
export class SchoolTeachersController {
  constructor(private readonly service: SchoolTeachersService) {}

  @Get()
  list(@Query('schoolId') schoolId: string) {
    return this.service.list(Number(schoolId));
  }

  @Post()
  create(@Body() body: any) {
    return this.service.create(body);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.service.update(id, body);
  }

  /** Ngừng dùng — không xoá hẳn để kỳ cũ vẫn hiện tên. */
  @Delete(':id')
  deactivate(@Param('id', ParseIntPipe) id: number) {
    return this.service.deactivate(id);
  }
}

/** Báo cáo "Lương giáo viên trường" theo tháng (thay tab Lương GV CTV ở QL thu chi). */
@Controller('school-teacher-payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_TEACHER_PAY_ROLES)
export class SchoolTeacherPayrollController {
  constructor(private readonly service: SchoolTeachersService) {}

  @Get()
  report(
    @Query('year') year?: string,
    @Query('month') month?: string,
    @Query('schoolId') schoolId?: string,
    @Query('schoolExpenseId') schoolExpenseId?: string,
  ) {
    return this.service.payrollReport({ year, month, schoolId, schoolExpenseId });
  }
}
