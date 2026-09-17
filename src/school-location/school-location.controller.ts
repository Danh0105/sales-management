import {
    Controller,
    Post,
    Get,
    Put,
    Delete,
    Patch,
    Body,
    Param,
    ParseIntPipe,
    Query,
    Req,
    UsePipes,
    ValidationPipe,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { SchoolLocationService } from './school-location.service';
import { CreateSchoolLocationDto } from './dto/create-school-location.dto';
import { UpdateSchoolLocationDto } from './dto/update-school-location.dto';
import { SchoolLocation } from './entities/school-location.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    assertCanManageTeaching,
    TEACHER_ROLES,
    TEACHING_MANAGE_ROLES,
    TEACHING_VIEW_ROLES,
    TEACHING_OWN_SCHOOLS_ROLES,
    resolveTeachingScope,
} from '../teaching/teaching-roles';

/**
 * Điểm trường (chi nhánh) của một trường — Nhân sự khai điểm trường trước, rồi
 * gắn lớp học vào đúng điểm (`POST /school-classes` với `schoolLocationId`).
 *
 * Giáo viên được đọc để hiển thị tên điểm trường trong lịch dạy của mình,
 * nhưng không sửa được — cùng ranh giới quyền với lớp học.
 */
@Controller('school-locations')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SchoolLocationController {
    constructor(private readonly service: SchoolLocationService) {}

    @Roles(...TEACHING_VIEW_ROLES, ...TEACHER_ROLES, ...TEACHING_OWN_SCHOOLS_ROLES)
    @Get()
    findBySchool(
        @Query('schoolId', ParseIntPipe) schoolId: number,
        @Req() req: Request,
    ): Promise<SchoolLocation[]> {
        return this.service.findBySchool(schoolId, resolveTeachingScope(req.user));
    }

    @Roles(...TEACHING_VIEW_ROLES, ...TEACHER_ROLES)
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number): Promise<SchoolLocation> {
        return this.service.findOne(id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Post()
    create(
        @Body() dto: CreateSchoolLocationDto,
        @Req() req: Request,
    ): Promise<SchoolLocation> {
        assertCanManageTeaching(req.user);
        return this.service.create(dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Put(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateSchoolLocationDto,
        @Req() req: Request,
    ): Promise<SchoolLocation> {
        assertCanManageTeaching(req.user);
        return this.service.update(id, dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Delete(':id')
    async remove(
        @Param('id', ParseIntPipe) id: number,
        @Req() req: Request,
    ): Promise<void> {
        assertCanManageTeaching(req.user);
        await this.service.remove(id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id/status')
    updateStatus(
        @Param('id', ParseIntPipe) id: number,
        @Body('status', ParseIntPipe) status: number,
        @Req() req: Request,
    ): Promise<SchoolLocation> {
        assertCanManageTeaching(req.user);
        return this.service.updateStatus(id, status);
    }
}
