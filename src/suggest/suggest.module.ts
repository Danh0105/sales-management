// suggest.module.ts
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Suggest } from './entities/suggest.entity';
import { SuggestService } from './suggest.service';
import { SuggestController } from './suggest.controller';
import { ExpenseRequestController } from './expense-request.controller';
import { SuggestHistory } from './entities/suggest-history.entity';
import { SuggestGateway } from './suggest.gateway';
import { Employee } from '../employee/employee.entity';
import { Policy } from '../policy/entities/policy.entity';
import { NotificationModule } from '../notifications/notification.module';
import { FcmModule } from '../fcm/fcm.module';

// ĐỀ XUẤT CHI (EXPENSE_REQUEST) — dùng chung SuggestService
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { SuggestAttachment } from './entities/suggest-attachment.entity';
import { SuggestReminderSetting } from './entities/suggest-reminder-setting.entity';
import { EmployeeFcmToken } from '../employee-fcm-token/employee-fcm-token.entity';


@Module({
    imports: [
        forwardRef(() => NotificationModule),
        FcmModule,
        TypeOrmModule.forFeature([
            Suggest,
            SuggestHistory,
            Employee,
            Policy,
            SuggestPaymentOrder,
            SuggestAttachment,
            SuggestReminderSetting,
            EmployeeFcmToken,
        ]),
    ],

    providers: [
        SuggestService,
        SuggestGateway,
    ],

    controllers: [
        SuggestController,
        ExpenseRequestController,
    ],

    exports: [
        SuggestGateway,
        SuggestService,
    ],
})

export class SuggestModule { }
