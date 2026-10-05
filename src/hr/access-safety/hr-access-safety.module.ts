import { Module } from '@nestjs/common';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrAccessSafetyService } from './hr-access-safety.service';

/**
 * Module nhỏ, chỉ export `HrAccessSafetyService` — để module employee cũ dùng
 * được luật quota quản trị HR mà không kéo theo controller/API nào của HR.
 */
@Module({
  imports: [HrAuditModule],
  providers: [HrAccessSafetyService],
  exports: [HrAccessSafetyService],
})
export class HrAccessSafetyModule {}
