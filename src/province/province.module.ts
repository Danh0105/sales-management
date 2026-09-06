import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Province } from './province.entity';
import { ProvinceService } from './province.service';
import { ProvinceController } from './province.controller';
import { EmployeeRegionSchoolModule } from 'src/employee-region-school/employee-region.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Province]),
        EmployeeRegionSchoolModule
    ],
    controllers: [ProvinceController],
    providers: [ProvinceService],
    exports: [ProvinceService],
})
export class ProvinceModule { }