import {
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Query,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BlockReadOnlyGuard } from '../auth/read-only.guard';
import { PolicyYearService } from './policy-year.service';
import { UpsertPolicyYearDto } from './dto/upsert-policy-year.dto';

@Controller('policy-years')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PolicyYearController {
    constructor(private readonly service: PolicyYearService) { }

    // Kế toán trưởng (read-only) không được ghi — GET vẫn xem bình thường.
    @UseGuards(BlockReadOnlyGuard)
    @Post('upsert')
    upsert(@Body() dto: UpsertPolicyYearDto) {
        return this.service.upsert(dto);
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
