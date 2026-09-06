import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SchoolLocation } from './entities/school-location.entity';
import { School } from '../school/schools.entity';
import { SchoolsModule } from '../school/schools.module';
import { SchoolLocationService } from './school-location.service';
import { SchoolLocationController } from './school-location.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([SchoolLocation, School]),
        SchoolsModule,
    ],
    providers: [SchoolLocationService],
    controllers: [SchoolLocationController],
    exports: [SchoolLocationService],
})
export class SchoolLocationModule {}
