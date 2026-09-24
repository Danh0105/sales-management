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
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { CreatePayrollDto } from './dto/create-payroll.dto';
import { QueryPayrollDto } from './dto/query-payroll.dto';
import { SendPayrollDto } from './dto/send-payroll.dto';
import { UpdatePayrollDto } from './dto/update-payroll.dto';
import { PayrollService } from './payroll.service';
import { PAYROLL_MANAGE_ROLES } from './payroll.roles';

@Controller('payrolls')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(...PAYROLL_MANAGE_ROLES)
  create(@Body() dto: CreatePayrollDto, @Req() req: Request) {
    return this.service.create(dto, req.user!);
  }

  @Get()
  findAll(@Query() query: QueryPayrollDto, @Req() req: Request) {
    return this.service.findAll(query, req.user!);
  }

  /**
   * Phụ cấp xăng xe của giáo viên công ty lấy từ bảng chấm công, không nhập
   * tay — người lập phiếu gọi endpoint này để lấy số gợi ý trước khi lưu.
   * Chỉ người lập phiếu mới cần, nên khoá theo `PAYROLL_MANAGE_ROLES`.
   */
  @Get('fuel-allowance')
  @UseGuards(RolesGuard)
  @Roles(...PAYROLL_MANAGE_ROLES)
  getFuelAllowanceFromAttendance(
    @Query('employeeId', ParseIntPipe) employeeId: number,
    @Query('month', ParseIntPipe) month: number,
    @Query('year', ParseIntPipe) year: number,
  ) {
    return this.service
      .computeFuelAllowanceFromAttendance(employeeId, month, year)
      .then((fuelAllowance) => ({ fuelAllowance }));
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    return this.service.findOne(id, req.user!);
  }

  /**
   * Gửi hàng loạt phiếu nháp đã chọn — checkbox "chọn tất cả" ở FE. Khai báo
   * trước `@Patch(':id')` để "send" không bị nuốt vào tham số `:id`.
   */
  @Patch('send')
  @UseGuards(RolesGuard)
  @Roles(...PAYROLL_MANAGE_ROLES)
  send(@Body() dto: SendPayrollDto, @Req() req: Request) {
    return this.service.send(dto.ids, req.user!);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(...PAYROLL_MANAGE_ROLES)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePayrollDto,
    @Req() req: Request,
  ) {
    return this.service.update(id, dto, req.user!);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(...PAYROLL_MANAGE_ROLES)
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
