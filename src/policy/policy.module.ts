import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Policy } from './entities/policy.entity';
import { Subject } from '../subject/subject.entity';

import { PolicyService } from './policy.service';
import { PolicyController } from './policy.controller';
import { PolicyContractMediaController } from './policy-contract-media.controller';
import { PolicyContractArchiveService } from './policy-contract-archive.service';
import { PolicyHistory } from './entities/policy-history.entity';

import { PolicyGateway } from './policy.gateway';
import { EmployeeFcmToken } from '../employee-fcm-token/employee-fcm-token.entity';
import { Employee } from '../employee/employee.entity';
import { NotifyModule } from '../notify-zalo/notify.module';
import { FcmModule } from '../fcm/fcm.module';
import { NotificationModule } from '../notifications/notification.module';
import { EmployeeFcmTokenModule } from '../employee-fcm-token/employee-fcm-token.module';
import { PolicyContractStorageService } from './policy-contract-storage.service';
import { JwtModule } from '@nestjs/jwt';
import { PolicyContractAccessService } from './policy-contract-access.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([Policy, Subject, PolicyHistory, Employee, EmployeeFcmToken]),
        JwtModule.register({}),
        NotifyModule,
        FcmModule,
        NotificationModule,
        EmployeeFcmTokenModule
    ],
    controllers: [PolicyController, PolicyContractMediaController],
    providers: [
        PolicyService,
        PolicyGateway,
        PolicyContractStorageService,
        PolicyContractArchiveService,
        PolicyContractAccessService,
    ],
    exports: [PolicyService,
        PolicyGateway,
        PolicyContractAccessService,],
})
export class PolicyModule { }
