import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VirtualTryOnJob } from './entities/virtual-tryon-job.entity';
import { VirtualTryOnController } from './virtual-tryon.controller';
import { VirtualTryOnService } from './virtual-tryon.service';
import { VirtualTryOnOpenAiService } from './virtual-tryon-openai.service';
import { VirtualTryOnStorageService } from './virtual-tryon-storage.service';
import { VirtualTryOnRateLimitService } from './virtual-tryon-rate-limit.service';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([VirtualTryOnJob])],
  controllers: [VirtualTryOnController],
  providers: [
    VirtualTryOnService,
    VirtualTryOnOpenAiService,
    VirtualTryOnStorageService,
    VirtualTryOnRateLimitService,
  ],
  exports: [VirtualTryOnService],
})
export class VirtualTryOnModule {}
