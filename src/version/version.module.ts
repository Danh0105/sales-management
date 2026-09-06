import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppVersion } from './version.entity';
import { AppVersionService } from './version.service';
import { AppVersionController } from './version.controller';
import { AdminVersionController } from './admin-version.controller';

@Module({
    imports: [
        TypeOrmModule.forFeature([AppVersion]),
    ],
    controllers: [
        AppVersionController,
        AdminVersionController,
    ],
    providers: [
        AppVersionService,
    ],
    exports: [
        AppVersionService,
    ],
})
export class AppVersionModule { }