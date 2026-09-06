import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Patch,
    Delete,
    Query,
} from '@nestjs/common';
import { WardService } from './ward.service';
import { CreateWardDto } from './dto/create-ward.dto';
import { UpdateWardDto } from './dto/update-ward.dto';
import { EmployeeRegionService } from 'src/employee-region-school/employee-region.service';

@Controller('wards')
export class WardController {
    constructor(
        private readonly service: WardService,
        private readonly employeeRegionService: EmployeeRegionService,
    ) { }

    @Post()
    create(@Body() dto: CreateWardDto) {
        return this.service.create(dto);
    }

    @Get()
    findAll(@Query('province_id') province_id?: number) {
        if (province_id) {
            return this.service.findByProvince(Number(province_id));
        }
        return this.service.findAll();
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(Number(id));
    }

    @Patch(':id')
    update(@Param('id') id: number, @Body() dto: UpdateWardDto) {
        return this.service.update(Number(id), dto);
    }

    @Delete(':id')
    remove(@Param('id') id: number) {
        return this.service.remove(Number(id));
    }
    @Get('/employee/:employeeId')
    getWardsByEmployee(
        @Param('employeeId') employeeId: number,
        @Query('provinceId') provinceId?: number,
    ) {
        return this.service.getWardsByEmployee(
            Number(employeeId),
            provinceId ? Number(provinceId) : undefined,
        );
    }

    @Delete(
        'revoke/ward/:employeeId/:wardId',
    )
    revokeWard(
        @Param('employeeId')
        employeeId: number,

        @Param('wardId')
        wardId: number,
    ) {

        return this.employeeRegionService.revokeWard(
            Number(employeeId),
            Number(wardId),
        );
    }
}