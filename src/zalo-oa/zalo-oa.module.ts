import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Employee } from '../employee/employee.entity';
import { NotifyModule } from '../notify-zalo/notify.module';
import { ZaloOaController } from './zalo-oa.controller';
import { ZaloOaService } from './zalo-oa.service';

@Module({
    imports: [TypeOrmModule.forFeature([Employee]), NotifyModule],
    controllers: [ZaloOaController],
    providers: [ZaloOaService],
    exports: [ZaloOaService],
})
export class ZaloOaModule { }
