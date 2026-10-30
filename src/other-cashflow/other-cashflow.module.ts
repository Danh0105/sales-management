import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashAccount } from '../cashflow-report/cash-account.entity';
import { Employee } from '../employee/employee.entity';
import { EmployeeFcmTokenModule } from '../employee-fcm-token/employee-fcm-token.module';
import { FcmModule } from '../fcm/fcm.module';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationModule } from '../notifications/notification.module';
import { School } from '../school/schools.entity';
import { OtherCashflowAttachment } from './entities/other-cashflow-attachment.entity';
import { OtherCashflowContract } from './entities/other-cashflow-contract.entity';
import { OtherCashflowCost } from './entities/other-cashflow-cost.entity';
import { OtherCashflowEntry } from './entities/other-cashflow-entry.entity';
import { OtherCashflowEvent } from './entities/other-cashflow-event.entity';
import { OtherCashflowItem } from './entities/other-cashflow-item.entity';
import { OtherCashflowOrder } from './entities/other-cashflow-order.entity';
import { OtherCashflowController } from './other-cashflow.controller';
import { OtherCashflowNotifyService } from './other-cashflow-notify.service';
import { OtherCashflowService } from './other-cashflow.service';

@Module({
  imports: [
    NotificationModule,
    FcmModule,
    EmployeeFcmTokenModule,
    TypeOrmModule.forFeature([
      OtherCashflowContract,
      OtherCashflowEntry,
      OtherCashflowAttachment,
      OtherCashflowEvent,
      OtherCashflowItem,
      OtherCashflowCost,
      OtherCashflowOrder,
      Employee,
      School,
      CashAccount,
      Notification,
    ]),
  ],
  controllers: [OtherCashflowController],
  providers: [OtherCashflowService, OtherCashflowNotifyService],
})
export class OtherCashflowModule {}
