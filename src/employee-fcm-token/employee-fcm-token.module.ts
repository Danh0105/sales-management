// employee-fcm-token.module.ts

import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { EmployeeFcmToken } from './employee-fcm-token.entity';

import { EmployeeFcmTokenService } from './employee-fcm-token.service';

import { EmployeeFcmTokenController } from './employee-fcm-token.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            EmployeeFcmToken,
        ]),
    ],

    providers: [
        EmployeeFcmTokenService,
    ],

    controllers: [
        EmployeeFcmTokenController,
    ],

    exports: [
        EmployeeFcmTokenService,
    ],
})
export class EmployeeFcmTokenModule { }