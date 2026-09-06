import { Controller, Get, Query } from '@nestjs/common';
import { StatisticsService } from './statistics.service';

@Controller('statistics')
export class StatisticsController {
    constructor(private readonly service: StatisticsService) { }

    @Get()
    async getStats(@Query('schoolYear') schoolYear: string) {
        return this.service.getStatisticsBySchoolYear(schoolYear);
    }
}