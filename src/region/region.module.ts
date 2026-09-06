import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Region } from './region.entity';
import { RegionService } from './region.service';
import { RegionController } from './region.controller';
import { Department } from 'src/department/department.entity';
import { EmployeeRegionSchoolModule } from 'src/employee-region-school/employee-region.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Region, Department]),
        EmployeeRegionSchoolModule
    ],
    controllers: [RegionController],
    providers: [RegionService],
    exports: [RegionService],
})
export class RegionModule { }