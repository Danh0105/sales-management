// app-version.controller.ts
import { Controller, Get } from '@nestjs/common';
import { AppVersionService } from './version.service';

@Controller('version')
export class AppVersionController {
    constructor(private service: AppVersionService) { }

    @Get()
    async getVersion() {
        const v = await this.service.getLatest();

        return {
            version: v?.version,
            apkUrl: v?.apkUrl,
            force: v?.isForce,
            note: v?.note,
        };
    }
}