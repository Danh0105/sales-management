import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAuditLog } from './entities/hr-audit-log.entity';
import { HrAuditQueryService } from './hr-audit-query.service';
import { HrAuditController } from './hr-audit.controller';
import { HrAuditService } from './hr-audit.service';

@Module({
  imports: [TypeOrmModule.forFeature([HrAuditLog]), HrAccessModule],
  controllers: [HrAuditController],
  providers: [HrAuditService, HrAuditQueryService],
  exports: [HrAuditService],
})
export class HrAuditModule {}
