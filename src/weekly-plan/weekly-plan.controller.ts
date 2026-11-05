import {
    Controller,
    Post,
    Body,
    Put,
    Param,
    Get,
    Delete,
    UseGuards,
} from '@nestjs/common';

import { WeeklyPlanService } from './weekly-plan.service';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('weekly-plans')
export class WeeklyPlanController {
    constructor(private readonly service: WeeklyPlanService) { }
    @Get('employee/:employeeId')
    getByEmployee(@Param('employeeId') employeeId: number) {
        return this.service.getByEmployee(+employeeId);
    }
    @Post()
    create(@Body() dto: CreateWeeklyPlanDto) {
        return this.service.create(dto);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(+id);
    }

    @Put(':id')
    update(@Param('id') id: number, @Body() dto: CreateWeeklyPlanDto) {
        return this.service.update(+id, dto);
    }

    @Delete(':id')
    remove(@Param('id') id: number) {
        return this.service.remove(+id);
    }

    @Get(':id/history')
    getHistory(@Param('id') id: number) {
        return this.service.getHistory(+id);
    }
}