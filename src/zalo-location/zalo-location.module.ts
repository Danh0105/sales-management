import { Module } from '@nestjs/common';
import { ZaloLocationController } from './zalo-location.controller';
import { ZaloLocationHttpClient } from './zalo-location-http.client';
import { ZaloLocationRateLimitGuard } from './zalo-location-rate-limit.guard';
import { ZaloLocationService } from './zalo-location.service';

@Module({
  controllers: [ZaloLocationController],
  providers: [
    ZaloLocationService,
    ZaloLocationHttpClient,
    ZaloLocationRateLimitGuard,
  ],
})
export class ZaloLocationModule {}
