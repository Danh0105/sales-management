import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { EmployeeRegionService } from "./employee-region.service";

import { EmployeeRegion } from "./entities/employee-region.entity";
import { Employee } from "../employee/employee.entity";
import { Region } from "../region/region.entity";
import { Province } from "../province/province.entity";
import { Ward } from "../ward/ward.entity";
import { EmployeeModule } from "../employee/employee.module";


@Module({

    imports: [
        forwardRef(() => EmployeeModule),
        TypeOrmModule.forFeature([EmployeeRegion, Employee, Region, Province, Ward]),
    ],
    providers: [EmployeeRegionService],
    exports: [EmployeeRegionService],
})
export class EmployeeRegionSchoolModule { }