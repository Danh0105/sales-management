import { Module } from '@nestjs/common';
import { NotifyService } from './notify.service';
import { ConfigModule } from '@nestjs/config';
import { ZaloTokenModule } from 'src/zalo-token/zalo-token.module';

@Module({
    imports: [ConfigModule, ZaloTokenModule],
    providers: [NotifyService],
    exports: [NotifyService],
})
export class NotifyModule { }