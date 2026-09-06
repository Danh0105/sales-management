// region.controller.ts
import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Patch,
    Delete,
} from '@nestjs/common';
import { RegionService } from './region.service';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { EmployeeRegionService } from '../employee-region-school/employee-region.service';

@Controller('regions')
export class RegionController {
    constructor(
        private readonly service: RegionService,
        private readonly employeeRegionService: EmployeeRegionService,
    ) { }

    @Post()
    create(@Body() dto: CreateRegionDto) {
        return this.service.create(dto);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(Number(id));
    }

    @Patch(':id')
    update(@Param('id') id: number, @Body() dto: UpdateRegionDto) {
        return this.service.update(Number(id), dto);
    }

    @Delete(':id')
    remove(@Param('id') id: number) {
        return this.service.remove(Number(id));
    }

    @Get('regions-by-department/:departmentId')
    getRegionsByDepartment(@Param('departmentId') departmentId: number) {
        return this.service.getRegionsByDepartment(Number(departmentId));
    }
    @Get('regions-by-employee/:employeeId')
    getRegionsByEmployee(@Param('employeeId') employeeId: number) {
        return this.employeeRegionService.getRegionsByEmployee(Number(employeeId));
    }

}