import {
    Module,
    forwardRef,
} from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { Notification } from './entities/notification.entity';

import { Employee } from '../employee/employee.entity';

import { Suggest } from '../suggest/entities/suggest.entity';

// controllers
import { NotificationController } from './controllers/notification.controller';

import { SuggestNotificationController } from './controllers/suggest-notification.controller';

import { ExpenseNotificationController } from './controllers/expense-notification.controller';

import { ReportNotificationController } from './controllers/report-notification.controller';

import { PlanNotificationController } from './controllers/plan-notification.controller';

// services
import { NotificationService } from './services/notification.service';
import { TeachingNotificationCleanupService } from './services/teaching-notification-cleanup.service';

import { SuggestNotificationService } from './services/suggest-notification.service';

import { ExpenseNotificationService } from './services/expense-notification.service';

import { ReportNotificationService } from './services/report-notification.service';

import { WeeklyPlanNotificationService } from './services/weekly-plan-notification.service';

// gateway
import { NotificationGateway } from './gateways/notification.geteway';

// listeners
import { SuggestListener } from '../suggest/listeners/suggest.listener';

// modules
import { FcmModule } from '../fcm/fcm.module';
import { NotifyModule } from '../notify-zalo/notify.module';

import { SuggestModule } from '../suggest/suggest.module';
import { PolicyNotificationController } from './controllers/policy-notification.controller';
import { TeachingScheduleNotificationController } from './controllers/teaching-schedule-notification.controller';

@Module({
    imports: [
        forwardRef(
            () => SuggestModule,
        ),

        FcmModule,
        NotifyModule,

        TypeOrmModule.forFeature([
            Notification,
            Employee,
            Suggest,
        ]),
    ],

    controllers: [
        NotificationController,
        PolicyNotificationController,

        TeachingScheduleNotificationController,

        SuggestNotificationController,

        ExpenseNotificationController,

        ReportNotificationController,

        PlanNotificationController,
    ],

    providers: [
        // core
        NotificationService,
        TeachingNotificationCleanupService,

        NotificationGateway,

        // feature services
        SuggestNotificationService,

        ExpenseNotificationService,

        ReportNotificationService,

        WeeklyPlanNotificationService,

        // listeners
        SuggestListener,
    ],

    exports: [
        NotificationService,

        NotificationGateway,

        SuggestNotificationService,

        ExpenseNotificationService,

        ReportNotificationService,

        WeeklyPlanNotificationService,
    ],
})
export class NotificationModule { }