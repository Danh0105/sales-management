import {
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Patch,
    Post,
    Query,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BlockReadOnlyGuard } from '../auth/read-only.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import {
    CASHFLOW_READ_ROLES,
    CASHFLOW_SALES_ADMIN_ROLES,
    CASHFLOW_WRITE_ROLES,
} from '../school-expenses/cashflow-roles';
import { PolicyYearService } from './policy-year.service';
import { UpsertPolicyYearDto } from './dto/upsert-policy-year.dto';
import { UpdatePolicyYearChecklistDto } from './dto/update-policy-year-checklist.dto';

@Controller('policy-years')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...CASHFLOW_READ_ROLES)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PolicyYearController {
    constructor(private readonly service: PolicyYearService) { }

    // Kế toán trưởng (read-only) không được ghi — GET vẫn xem bình thường.
    @UseGuards(BlockReadOnlyGuard)
    @Roles(...CASHFLOW_WRITE_ROLES)
    @Post('upsert')
    upsert(@Body() dto: UpsertPolicyYearDto) {
        return this.service.upsert(dto);
    }

    @Roles(...CASHFLOW_SALES_ADMIN_ROLES)
    @Patch('checklist')
    updateChecklist(@Body() dto: UpdatePolicyYearChecklistDto) {
        return this.service.updateChecklist(dto);
    }

    @Roles(...CASHFLOW_SALES_ADMIN_ROLES)
    @Get('checklist')
    getChecklist(
        @Query('schoolId') schoolId: string,
        @Query('schoolYear') schoolYear: string,
    ) {
        return this.service.findChecklistForSchoolYear(
            Number(schoolId),
            schoolYear,
        );
    }

    @Get()
    find(
        @Query('schoolId') schoolId?: string,
        @Query('schoolYear') schoolYear?: string,
    ) {
        // Đúng trường + năm học → trả record (hoặc null); còn lại → danh sách.
        if (schoolId && schoolYear) {
            return this.service.findForSchoolYear(Number(schoolId), schoolYear);
        }
        return this.service.findAll({
            schoolId: schoolId ? Number(schoolId) : undefined,
            schoolYear,
        });
    }

    @Get(':id')
    findOne(@Param('id', ParseIntPipe) id: number) {
        return this.service.findOne(id);
    }
}
