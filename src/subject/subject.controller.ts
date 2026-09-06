import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Delete,
    Put,
    Query,
    Patch,
    ParseIntPipe,
    Req,
    UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SubjectsService } from './subject.service';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { BulkUpdateSubjectRateDto } from './dto/bulk-update-subject-rate.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { assertCanSetTeachingRates } from '../teaching/teaching-roles';

/** Field tiền — chỉ Nhân sự được khai, xem `assertCanSetTeachingRates`. */
const SUBJECT_RATE_FIELDS = ['ratePerPeriod'] as const;

@Controller('subjects')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SubjectsController {
    constructor(private readonly service: SubjectsService) { }
    @Get('by-subject')
    getSchoolsBySubject(
        @Query('schoolYear') schoolYear?: string,
        @Query('name') name?: string,
        @Query('catalogId') catalogId?: string,
    ) {
        return this.service.getSchoolsBySubject(
            schoolYear,
            name,
            catalogId ? Number(catalogId) : undefined,
        );
    }
    @Get('school/:schoolYear')
    findBySchool(
        @Param('schoolYear') schoolYear: string,
        @Query('schoolId') schoolId: string,
    ) {
        return this.service.findBySchoolYearAndSchool(
            schoolYear,
            Number(schoolId),
        );
    }
    @Get('finance/:schoolId')
    async findFinanceBySchool(
        @Param('schoolId', ParseIntPipe)
        schoolId: number,

        @Query('schoolYear')
        schoolYear?: string,
    ) {
        return this.service.findFinanceBySchool(
            schoolId,
            schoolYear,
        );
    }
    @Post()
    create(@Body() dto: CreateSubjectDto, @Req() req: Request) {
        assertCanSetTeachingRates(req.user, dto, SUBJECT_RATE_FIELDS);
        return this.service.create(dto);
    }

    /**
     * Áp một đơn giá cho nhiều môn học (nhiều trường) cùng lúc — xem
     * `BulkUpdateSubjectRateDto`.
     */
    @Patch('bulk-rate')
    bulkUpdateRate(@Body() dto: BulkUpdateSubjectRateDto, @Req() req: Request) {
        assertCanSetTeachingRates(req.user, dto, SUBJECT_RATE_FIELDS);
        return this.service.bulkUpdateRate(dto.subjectIds, dto.ratePerPeriod);
    }

    @Get()
    findAll(@Query('schoolId') schoolId?: string) {
        if (schoolId) return this.service.findBySchool(+schoolId);
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(+id);
    }

    @Put(':id')
    update(@Param('id') id: string, @Body() dto: UpdateSubjectDto, @Req() req: Request) {
        assertCanSetTeachingRates(req.user, dto, SUBJECT_RATE_FIELDS);
        return this.service.update(+id, dto);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.service.remove(+id);
    }

}