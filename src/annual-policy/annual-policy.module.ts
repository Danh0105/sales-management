import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnnualPolicy } from './entities/annual-policy.entity';
import { School } from '../school/schools.entity';
import { Employee } from '../employee/employee.entity';

import { AnnualPolicyService } from './annual-policy.service';
import { AnnualPolicyController } from './annual-policy.controller';
import { AnnualPolicyContractStorageService } from './annual-policy-contract-storage.service';

import { FcmModule } from '../fcm/fcm.module';
import { NotificationModule } from '../notifications/notification.module';
import { EmployeeFcmTokenModule } from '../employee-fcm-token/employee-fcm-token.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([AnnualPolicy, School, Employee]),
        FcmModule,
        NotificationModule,
        EmployeeFcmTokenModule,
    ],
    controllers: [AnnualPolicyController],
    providers: [AnnualPolicyService, AnnualPolicyContractStorageService],
    exports: [AnnualPolicyService],
})
export class AnnualPolicyModule { }
