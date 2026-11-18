import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StatisticsService } from './statistics.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('statistics')
export class StatisticsController {
    constructor(private readonly service: StatisticsService) { }

    @Get()
    async getStats(@Query('schoolYear') schoolYear: string) {
        return this.service.getStatisticsBySchoolYear(schoolYear);
    }
}