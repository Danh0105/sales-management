import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ward } from './ward.entity';
import { WardService } from './ward.service';
import { WardController } from './ward.controller';
import { EmployeeRegion } from '../employee-region-school/entities/employee-region.entity';
import { EmployeeRegionSchoolModule } from '../employee-region-school/employee-region.module';


@Module({
    imports:
        [TypeOrmModule.forFeature([Ward, EmployeeRegion]),
            EmployeeRegionSchoolModule
        ],
    controllers: [WardController],
    providers: [WardService],
    exports: [WardService],
})
export class WardModule { }