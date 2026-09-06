import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PolicyYear } from './entities/policy-year.entity';
import { PolicyYearSubject } from './entities/policy-year-subject.entity';
import { PolicyYearMonthlyRow } from './entities/policy-year-monthly-row.entity';
import { School } from '../school/schools.entity';

import { PolicyYearService } from './policy-year.service';
import { PolicyYearController } from './policy-year.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            PolicyYear,
            PolicyYearSubject,
            PolicyYearMonthlyRow,
            School,
        ]),
    ],
    controllers: [PolicyYearController],
    providers: [PolicyYearService],
    exports: [PolicyYearService],
})
export class PolicyYearModule { }
