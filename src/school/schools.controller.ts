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
    Req,
    UseGuards,
    UsePipes,
    ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';

import { SchoolsService } from './schools.service';
import { SchoolPeriodService } from './school-period.service';
import { ReplaceSchoolPeriodsDto } from './dto/school-period.dto';
import { CreateSchoolDto } from './dto/create-school.dto';
import { UpdateSchoolDto } from './dto/update-school.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ResolveGoogleMapsDto } from './dto/resolve-google-maps.dto';

@Controller('schools')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class SchoolsController {
    constructor(
        private readonly service: SchoolsService,
        private readonly periodService: SchoolPeriodService,
    ) { }

    /**
     * Bảng giờ tiết học của một trường (Tiết 1 07:00–07:45...).
     *
     * Khai báo TRƯỚC `@Get(':id')` — Nest khớp route theo thứ tự, để sau thì
     * ':id' nuốt mất đường dẫn này.
     */
    @UseGuards(JwtAuthGuard)
    @Get(':id/periods')
    findPeriods(@Param('id') id: string) {
        return this.periodService.findBySchool(Number(id));
    }

    /** Ghi đè cả bảng tiết của trường trong một lần lưu. */
    @UseGuards(JwtAuthGuard)
    @Put(':id/periods')
    replacePeriods(
        @Param('id') id: string,
        @Body() dto: ReplaceSchoolPeriodsDto,
    ) {
        return this.periodService.replace(Number(id), dto);
    }

    @UseGuards(JwtAuthGuard)
    @Post('resolve-google-maps')
    resolveGoogleMaps(@Body() dto: ResolveGoogleMapsDto) {
        return this.service.resolveGoogleMaps(dto.url);
    }
    @Get('search/:keyword')
    search(@Param('keyword') keyword: string) {
        return this.service.search(keyword);
    }

    // 🔒 Nhân viên chỉ tìm kiếm được trong các trường thuộc quản lý của chính mình
    @UseGuards(JwtAuthGuard)
    @Get('my/search')
    searchMySchools(
        @Query('keyword') keyword: string | undefined,
        @Req() req: Request,
    ) {
        return this.service.searchMySchools(req.user!.id, keyword);
    }
    @Get('by-employee-ward')
    getByEmployeeWard(
        @Query('employeeId') employeeId: number,
        @Query('wardId') wardId: number,
    ) {
        return this.service.getByEmployeeAndWard(
            Number(employeeId),
            Number(wardId),
        );
    }
    @Get('by-ward/:wardId')
    findByWard(@Param('wardId') wardId: string) {
        return this.service.findByWard(+wardId);
    }
    @Get('by-employee/:employeeId')
    findByEmployee(@Param('employeeId') employeeId: string) {
        return this.service.findByEmployee(+employeeId);
    }
    @Get('by-employee-name/:name')
    findByEmployeeName(@Param('name') name: string) {
        return this.service.findByEmployeeName(name);
    }
    @Post()
    create(@Body() dto: CreateSchoolDto) {
        return this.service.create(dto);
    }

    @Patch(':id/status')
    updateStatus(
        @Param('id') id: number,
        @Body('status') status: number,
    ) {
        return this.service.updateStatus(id, status);
    }

    @Get()
    findAll(
        @Query() query: any,
    ) {
        return this.service.findAll(query);
    }


    @Get(':id')
    findOne(@Param('id') id: string) {
        return this.service.findOne(+id);
    }

    @Put(':id')
    update(@Param('id') id: string, @Body() dto: UpdateSchoolDto) {
        return this.service.update(+id, dto);
    }

    @Delete(':id')
    remove(@Param('id') id: string) {
        return this.service.remove(+id);
    }
    @Get('/employee-region/:id')
    findByEmployeeRegion(@Param('id') id: number) {
        return this.service.findByEmployeeRegion(Number(id));
    }

}
