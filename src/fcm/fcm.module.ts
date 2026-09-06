import { Module } from '@nestjs/common';
import { FcmService } from './fcm.service';
import { EmployeeFcmTokenModule } from 'src/employee-fcm-token/employee-fcm-token.module';

@Module({
    imports: [
        EmployeeFcmTokenModule,
    ],
    providers: [FcmService],
    exports: [FcmService],
})
export class FcmModule { }