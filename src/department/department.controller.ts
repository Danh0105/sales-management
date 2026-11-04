// department.controller.ts
import { Controller, Get, Post, Body, Param, Patch, Delete, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { DepartmentService } from './department.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

/** Thêm/sửa/xoá phòng ban — chỉ giám đốc. */
export const DEPARTMENT_ADMIN_ROLES = ['director'];

/** Mọi API phòng ban cần đăng nhập; xem thì ai đăng nhập cũng được. */
@Controller('departments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DepartmentController {
    constructor(private readonly service: DepartmentService) { }

    @Post()
    @Roles(...DEPARTMENT_ADMIN_ROLES)
    create(@Body() dto: CreateDepartmentDto) {
        return this.service.create(dto);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(Number(id));
    }

    @Patch(':id')
    @Roles(...DEPARTMENT_ADMIN_ROLES)
    update(@Param('id') id: number, @Body() dto: UpdateDepartmentDto) {
        return this.service.update(Number(id), dto);
    }

    @Delete(':id')
    @Roles(...DEPARTMENT_ADMIN_ROLES)
    remove(@Param('id') id: number) {
        return this.service.remove(Number(id));
    }
}
