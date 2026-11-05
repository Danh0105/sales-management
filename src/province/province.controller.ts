import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Patch,
    Delete,
    UseGuards,
    Req,
} from '@nestjs/common';
import { ProvinceService } from './province.service';
import { CreateProvinceDto } from './dto/create-province.dto';
import { UpdateProvinceDto } from './dto/update-province.dto';
import { EmployeeRegionService } from 'src/employee-region-school/employee-region.service';
import { RegionService } from 'src/region/region.service';
import { JwtAuthGuard } from 'src/auth/jwt-auth.guard';
import { HandoverRegionDto } from 'src/employee-region-school/dto/handover-region.dto';
import { LA_PROVINCE_ID } from '../policy/policy-scope';
import { isRestrictedLongAnDirector } from '../long-an-director/long-an-scope.service';

@UseGuards(JwtAuthGuard)
@Controller('provinces')
export class ProvinceController {
    constructor(
        private readonly service: ProvinceService,
        private readonly employeeRegionService: EmployeeRegionService,


    ) { }

    @Post()
    create(@Body() dto: CreateProvinceDto) {
        return this.service.create(dto);
    }

    @UseGuards(JwtAuthGuard)
    @Get()
    findAll(@Req() req) {
        return this.service.findAll(req.user);
    }

    @Get(':id')
    findOne(@Param('id') id: number) {
        return this.service.findOne(Number(id));
    }

    @Patch(':id')
    update(@Param('id') id: number, @Body() dto: UpdateProvinceDto) {
        return this.service.update(Number(id), dto);
    }

    @Delete(':id')
    remove(@Param('id') id: number) {
        return this.service.remove(Number(id));
    }

    @Get('provinces-by-employee/:employeeId')
    async getByEmployee(@Param('employeeId') employeeId: number, @Req() req) {
        const provinces = await this.employeeRegionService.getProvincesByEmployee(
            Number(employeeId),
        );
        // Nhân viên kiêm nhiều tỉnh: Giám đốc Long An chỉ thấy tỉnh của mình.
        return isRestrictedLongAnDirector(req.user?.roles)
            ? provinces.filter((province: any) => Number(province.id) === LA_PROVINCE_ID)
            : provinces;
    }

    @Get('available-provinces/:employeeId')
    getAvailableProvinces(@Param('employeeId') employeeId: number) {
        return this.employeeRegionService.getAvailableProvinces(Number(employeeId));
    }

    @Post('add-many-to-province')
    addManyToProvince(
        @Body() body: { employeeId: number; provinceIds: number[] },
    ) {
        return this.employeeRegionService.addManyToProvince(
            body.employeeId,
            body.provinceIds,
        );
    }
    @Delete('remove-province')
    removeProvince(
        @Body() body: { employeeId: number; provinceId: number },
    ) {
        return this.employeeRegionService.removeProvince(
            body.employeeId,
            body.provinceId,
        );
    }
    @Post('handover')
    handover(
        @Body() dto: HandoverRegionDto,
    ) {
        return this.employeeRegionService.handoverRegion(dto);
    }
    @Delete(
        'revoke/province/:employeeId/:provinceId',
    )

    revokeProvince(
        @Param('employeeId')
        employeeId: number,

        @Param('provinceId')
        provinceId: number,
    ) {

        return this.employeeRegionService.revokeProvince(
            Number(employeeId),
            Number(provinceId),
        );
    }
}