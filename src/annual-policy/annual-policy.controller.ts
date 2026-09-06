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
} from '@nestjs/common';
import type { Request } from 'express';

import { AnnualPolicyService } from './annual-policy.service';
import { CreateAnnualPolicyDto } from './dto/create-annual-policy.dto';
import { ReviewAnnualPolicyDto } from './dto/review-annual-policy.dto';
import { AnnualPolicyStatus } from './annual-policy.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { BlockReadOnlyGuard } from '../auth/read-only.guard';

@Controller('annual-policies')
export class AnnualPolicyController {
    constructor(private readonly service: AnnualPolicyService) { }

    @UseGuards(JwtAuthGuard, BlockReadOnlyGuard)
    @Post()
    create(@Body() dto: CreateAnnualPolicyDto, @Req() req: Request) {
        return this.service.create(dto, {
            id: req.user!.id,
            name: req.user!.name,
        });
    }

    @UseGuards(JwtAuthGuard, RolesGuard)
    @Roles('director', 'director_la')
    @Patch(':id/review')
    review(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ReviewAnnualPolicyDto,
        @Req() req: Request,
    ) {
        return this.service.review(id, dto, {
            id: req.user!.id,
            name: req.user!.name,
        });
    }

    @UseGuards(JwtAuthGuard)
    @Get()
    findAll(
        @Query('employeeId') employeeId?: string,
        @Query('schoolId') schoolId?: string,
        @Query('status') status?: AnnualPolicyStatus,
        @Query('schoolYear') schoolYear?: string,
    ) {
        return this.service.findAll({
            employeeId: employeeId ? Number(employeeId) : undefined,
            schoolId: schoolId ? Number(schoolId) : undefined,
            status,
            schoolYear,
        });
    }

    @UseGuards(JwtAuthGuard)
    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }
}
