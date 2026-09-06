import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SchoolsService } from './schools.service';
import { SchoolsController } from './schools.controller';
import { School } from './schools.entity';
import { SchoolPeriod } from './entities/school-period.entity';
import { SchoolPeriodService } from './school-period.service';
import { Employee } from '../employee/employee.entity';

@Module({
    imports: [TypeOrmModule.forFeature([School, SchoolPeriod, Employee])],
    controllers: [SchoolsController],
    providers: [SchoolsService, SchoolPeriodService],
    // TeachingModule dùng resolveGoogleMaps() để giải toạ độ giáo viên — tái dùng
    // thay vì nhân bản đoạn chống SSRF.
    exports: [SchoolsService, SchoolPeriodService],
})
export class SchoolsModule { }