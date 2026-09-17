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
import { SchoolClassService } from './school-class.service';
import {
    CreateSchoolClassDto,
    QuerySchoolClassesDto,
    UpdateSchoolClassDto,
} from './dto/school-class.dto';
import {
    assertCanManageTeaching,
    assertCanSetTeachingRates,
    TEACHER_ROLES,
    TEACHING_MANAGE_ROLES,
    TEACHING_VIEW_ROLES,
    TEACHING_OWN_SCHOOLS_ROLES,
    resolveTeachingScope,
} from './teaching-roles';

/**
 * Quản lý lớp học của từng trường — Nhân sự tạo lớp trước, rồi mới xếp lịch dạy
 * cho lớp đó (`POST /teaching-schedules` với `classId`).
 *
 * Giáo viên được đọc danh sách lớp để hiển thị tên lớp trong lịch của mình,
 * nhưng không sửa được.
 */
@Controller('school-classes')
@UseGuards(JwtAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SchoolClassController {
    constructor(private readonly service: SchoolClassService) { }

    @Roles(...TEACHING_VIEW_ROLES, ...TEACHER_ROLES, ...TEACHING_OWN_SCHOOLS_ROLES)
    @Get()
    findAll(@Query() query: QuerySchoolClassesDto, @Req() req: Request) {
        return this.service.findAll(query, resolveTeachingScope(req.user));
    }

    @Roles(...TEACHING_VIEW_ROLES, ...TEACHER_ROLES)
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Post()
    create(@Body() dto: CreateSchoolClassDto, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        assertCanSetTeachingRates(req.user, dto);
        return this.service.create(dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateSchoolClassDto,
        @Req() req: Request,
    ) {
        assertCanManageTeaching(req.user);
        assertCanSetTeachingRates(req.user, dto);
        return this.service.update(id, dto);
    }

    @Roles(...TEACHING_MANAGE_ROLES)
    @Delete(':id')
    remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        assertCanManageTeaching(req.user);
        return this.service.remove(id);
    }
}
