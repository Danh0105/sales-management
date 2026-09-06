import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { FuelAllowanceTierService } from './fuel-allowance-tier.service';
import {
  CreateFuelAllowanceTierDto,
  UpdateFuelAllowanceTierDto,
} from './dto/fuel-allowance-tier.dto';
import { TEACHING_RATE_ROLES, TEACHING_VIEW_ROLES } from './teaching-roles';

/**
 * Bậc phụ cấp xăng theo khoảng cách — chỉ Nhân sự khai (cùng ranh giới với
 * đơn giá mỗi tiết), các role xem lịch dạy khác được đọc để hiểu bảng công.
 */
@Controller('fuel-allowance-tiers')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class FuelAllowanceTierController {
  constructor(private readonly service: FuelAllowanceTierService) {}

  @Roles(...TEACHING_VIEW_ROLES)
  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Roles(...TEACHING_RATE_ROLES)
  @Post()
  create(@Body() dto: CreateFuelAllowanceTierDto) {
    return this.service.create(dto);
  }

  @Roles(...TEACHING_RATE_ROLES)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateFuelAllowanceTierDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles(...TEACHING_RATE_ROLES)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
