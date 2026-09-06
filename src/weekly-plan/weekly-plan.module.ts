import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WeeklyPlan } from './entities/weekly-plan.entity';
import { WeeklyPlanTask } from './entities/weekly-plan-task.entity';
import { WeeklyPlanHistory } from './entities/weekly-plan-history.entity';

import { WeeklyPlanService } from './weekly-plan.service';
import { WeeklyPlanController } from './weekly-plan.controller';
import { Policy } from 'src/policy/entities/policy.entity';
import { Employee } from 'src/employee/employee.entity';
import { Subject } from 'rxjs';
import { FcmModule } from 'src/fcm/fcm.module';
import { PolicyModule } from 'src/policy/policy.module';
import { NotificationModule } from 'src/notifications/notification.module';
import { EmployeeFcmTokenModule } from 'src/employee-fcm-token/employee-fcm-token.module';
import { WeeklyPlanGateway } from './weekly-plan.gateway';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            WeeklyPlan,
            WeeklyPlanTask,
            WeeklyPlanHistory,
            Policy,
            Subject,
            Employee,
        ]),
        PolicyModule,
        FcmModule,
        NotificationModule,
        EmployeeFcmTokenModule,
    ],
    controllers: [WeeklyPlanController],
    providers: [
        WeeklyPlanService,
        WeeklyPlanGateway,
    ],
})
export class WeeklyPlanModule { }