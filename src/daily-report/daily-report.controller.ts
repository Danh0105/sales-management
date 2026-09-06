import { Controller, Get, Post, Body, Param, Delete, ParseIntPipe, Put, Patch, UseGuards, Req } from '@nestjs/common';
import { DailyReportService } from './daily-report.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { CreateReportMessageDto } from './dto/create-report-message';
import { Employee } from '../employee/employee.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

type RequestWithUser = Request & {
    user: Employee;
};

@Controller('daily-reports')
export class DailyReportController {
    constructor(private readonly service: DailyReportService) { }

    @Post()
    create(@Body() dto: CreateReportDto) {
        return this.service.create(dto);
    }

    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateReportDto,
    ) {
        return this.service.update(id, dto);
    }
    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(+id);
    }

    @Delete(':id')
    remove(@Param('id') id: number) {
        console.log(id)
        return this.service.remove(+id);
    }

    @Get('employee/:employeeId')
    findByEmployee(@Param('employeeId') employeeId: number) {
        return this.service.findByEmployee(employeeId);
    }

    @Get('employee/:employeeId/weeks')
    findByEmployeeGroupByWeek(
        @Param('employeeId', ParseIntPipe) employeeId: number,
    ) {
        return this.service.findByEmployeeGroupByWeek(employeeId);
    }
    @Get('today/employees')
    async getEmployeesReportedToday() {
        return this.service.findEmployeesReportedToday();
    }
    @Delete('task/:id')
    removeTask(@Param('id') id: number) {
        return this.service.removeTask(+id);
    }
    @UseGuards(JwtAuthGuard)
    @Post('messages')
    createMessage(
        @Body() dto: CreateReportMessageDto,
        @Req() req: RequestWithUser,
    ) {
        return this.service.createMessage(
            dto,
            req.user,
        );
    }

    @Get(':id/messages')
    findMessagesByReport(
        @Param('id', ParseIntPipe) id: number,
    ) {
        return this.service.findMessagesByReport(id);
    }
}