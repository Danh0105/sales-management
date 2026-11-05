import { Controller, Get, Post, Body, Param, Delete, ParseIntPipe, Put, Patch, UseGuards, Req } from '@nestjs/common';
import { DailyReportService } from './daily-report.service';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { CreateReportMessageDto } from './dto/create-report-message';
import { Employee } from '../employee/employee.entity';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { isRestrictedLongAnDirector } from '../long-an-director/long-an-scope.service';
import { LA_PROVINCE_ID } from '../policy/policy-scope';

type RequestWithUser = Request & {
    user: Employee;
};

@UseGuards(JwtAuthGuard)
@Controller('daily-reports')
export class DailyReportController {
    constructor(private readonly service: DailyReportService) { }

    @Post()
    create(@Body() dto: CreateReportDto, @Req() req: RequestWithUser) {
        const canCreateForOthers = req.user.roles?.some((role) =>
            ['director', 'director_la', 'saleadmin', 'salesadmin', 'salesadmin_la'].includes(role),
        );
        return this.service.create(
            {
                ...dto,
                employeeId: canCreateForOthers ? dto.employeeId : Number(req.user.id),
            },
            req.user,
        );
    }

    @Patch(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: UpdateReportDto,
        @Req() req: RequestWithUser,
    ) {
        return this.service.update(id, dto, req.user);
    }
    @Get()
    findAll(@Req() req: RequestWithUser) {
        return this.service.findAll(
            isRestrictedLongAnDirector(req.user?.roles)
                ? LA_PROVINCE_ID
                : undefined,
        );
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(+id);
    }

    @Delete(':id')
    remove(@Param('id') id: number, @Req() req: RequestWithUser) {
        return this.service.remove(+id, req.user);
    }

    @Get('employee/:employeeId')
    findByEmployee(
        @Param('employeeId') employeeId: number,
        @Req() req: RequestWithUser,
    ) {
        return this.service.findByEmployee(
            employeeId,
            isRestrictedLongAnDirector(req.user?.roles)
                ? LA_PROVINCE_ID
                : undefined,
        );
    }

    @Get('employee/:employeeId/weeks')
    findByEmployeeGroupByWeek(
        @Param('employeeId', ParseIntPipe) employeeId: number,
        @Req() req: RequestWithUser,
    ) {
        return this.service.findByEmployeeGroupByWeek(
            employeeId,
            isRestrictedLongAnDirector(req.user?.roles)
                ? LA_PROVINCE_ID
                : undefined,
        );
    }
    @Get('today/employees')
    async getEmployeesReportedToday(@Req() req: RequestWithUser) {
        return this.service.findEmployeesReportedToday(
            isRestrictedLongAnDirector(req.user?.roles)
                ? LA_PROVINCE_ID
                : undefined,
        );
    }
    @Delete('task/:id')
    removeTask(@Param('id') id: number, @Req() req: RequestWithUser) {
        return this.service.removeTask(+id, req.user);
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
