import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from './employee.entity';
import { EmployeeService } from './employee.service';
import { EmployeeController } from './employee.controller';
import { EmployeeRegionSchoolModule } from '../employee-region-school/employee-region.module';
import { DepartmentModule } from '../department/department.module';
import { RegionModule } from '../region/region.module';
import { EmployeeFace } from './employee-face.entity';
import { AvatarStorageService } from '../teaching/avatar-storage.service';


@Module({
    imports: [

        forwardRef(() =>
            EmployeeRegionSchoolModule,
        ),

        TypeOrmModule.forFeature([
            Employee,
            EmployeeFace,
        ]),

        DepartmentModule,

        RegionModule,
    ],

    providers: [
        EmployeeService,
        AvatarStorageService,
    ],

    controllers: [
        EmployeeController,
    ],

    exports: [
        EmployeeService,

        TypeOrmModule,
    ],
})
export class EmployeeModule { }