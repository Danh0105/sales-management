import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrEmployeesModule } from '../employees/hr-employees.module';
import { HrFile } from './entities/hr-file.entity';
import { HrFileContentController } from './hr-file-content.controller';
import { HrFileController } from './hr-file.controller';
import { HrFileService } from './hr-file.service';
import { HR_PRIVATE_STORAGE } from './storage/hr-private-storage';
import { LocalHrPrivateStorage } from './storage/local-hr-private-storage';

/**
 * Kho tài liệu riêng: thiếu/sai `HR_PRIVATE_STORAGE_DIR` → app vẫn chạy, chức
 * năng file trả 503. Đổi sang S3/MinIO = thay provider `HR_PRIVATE_STORAGE`.
 * Không phụ thuộc HrCryptoModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HrFile]),
    HrAccessModule,
    HrAuditModule,
    HrEmployeesModule,
  ],
  controllers: [HrFileController, HrFileContentController],
  providers: [
    HrFileService,
    {
      provide: HR_PRIVATE_STORAGE,
      useFactory: () => LocalHrPrivateStorage.fromEnv(process.env),
    },
  ],
  // Phase 1.3 — module Documents ghi/lưu trữ file qua đúng service này.
  exports: [HrFileService],
})
export class HrFilesModule {}
