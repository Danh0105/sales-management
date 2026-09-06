import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Subject } from './subject.entity';
import { School } from '../school/schools.entity';

import { SubjectsService } from './subject.service';
import { SubjectsController } from './subject.controller';
import { SubjectMergeController } from './subject-merge.controller';
import { SubjectMergeService } from './subject-merge.service';
import { SchoolYearRolloverController } from './school-year-rollover.controller';
import { SchoolYearRolloverService } from './school-year-rollover.service';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { ExpenseItem } from '../expense-item/expense-item.entity';
import { CashPolicyItem } from '../cash-policy-item/cash-policy-item.entity';
import { SubjectCatalogsModule } from '../subject-catalog/subject-catalog.module';
import { SchoolLocationModule } from '../school-location/school-location.module';

@Module({
    imports: [TypeOrmModule.forFeature([Subject, School,SchoolExpense, CashPolicyItem, ExpenseItem]),
        SubjectCatalogsModule,
        SchoolLocationModule,
    ],
    controllers: [
        SubjectsController,
        SubjectMergeController,
        SchoolYearRolloverController,
    ],
    providers: [SubjectsService, SubjectMergeService, SchoolYearRolloverService],
    exports: [SubjectMergeService, SchoolYearRolloverService],
})
export class SubjectsModule { }