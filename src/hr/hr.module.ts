import { Module } from '@nestjs/common';
import { HrAccessModule } from './access/hr-access.module';
import { HrAuditModule } from './audit/hr-audit.module';
import { HrAccessAdminModule } from './access-admin/hr-access-admin.module';
import { HrAccessSafetyModule } from './access-safety/hr-access-safety.module';
import { HrCryptoModule } from './crypto/hr-crypto.module';
import { HrDocumentsModule } from './documents/hr-documents.module';
import { HrEmployeesModule } from './employees/hr-employees.module';
import { HrFilesModule } from './files/hr-files.module';
import { HrOrganizationModule } from './organization/hr-organization.module';

/**
 * Điểm vào duy nhất của HRM trong `AppModule`.
 *
 * Mọi entity dưới `src/hr` phải có `schema: 'hr'` + `synchronize: false`
 * (kiểm tra bởi `hr-entity-guard.spec.ts`): runtime còn `synchronize: true`,
 * và bảng HR chỉ được tạo/sửa qua `src/hr/migrations`.
 *
 * `HrCryptoModule` không bao giờ làm hỏng khởi động: thiếu khoá → chỉ chức
 * năng HR cần mã hoá trả 503, phần còn lại (kể cả module cũ) vẫn chạy.
 */
@Module({
  imports: [
    HrAccessModule,
    HrAuditModule,
    HrAccessAdminModule,
    HrAccessSafetyModule,
    HrCryptoModule,
    HrEmployeesModule,
    HrFilesModule,
    HrDocumentsModule,
    HrOrganizationModule,
  ],
})
export class HrModule {}
