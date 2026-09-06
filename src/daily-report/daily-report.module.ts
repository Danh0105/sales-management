import { Module } from '@nestjs/common';

import { TypeOrmModule }
    from '@nestjs/typeorm';

import { DailyReport }
    from './entities/daily-report.entity';

import { Task }
    from './entities/task.entity';

import { DailyReportService }
    from './daily-report.service';

import { DailyReportController }
    from './daily-report.controller';

import { Employee }
    from '../employee/employee.entity';

import { ReportGateway }
    from './report.gateway';

import { NotificationModule }
    from '../notifications/notification.module';

import { FcmModule }
    from '../fcm/fcm.module';
import { ReportMessage } from './entities/report-message.entity';

@Module({

    imports: [

        TypeOrmModule.forFeature([
            DailyReport,
            Task,
            Employee,
            ReportMessage
        ]),
        NotificationModule,
        FcmModule,
    ],

    controllers: [
        DailyReportController,
    ],

    providers: [
        DailyReportService,
        ReportGateway,
    ],

    exports: [
        DailyReportService,
    ],
})
export class DailyReportModule { }