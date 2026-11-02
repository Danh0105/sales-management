import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrEmployeesModule } from '../employees/hr-employees.module';
import { HrFilesModule } from '../files/hr-files.module';
import { EmployeeDocumentVersion } from './entities/employee-document-version.entity';
import { EmployeeDocument } from './entities/employee-document.entity';
import { HrDocumentController } from './hr-document.controller';
import { HrDocumentService } from './hr-document.service';

/** Hồ sơ tài liệu nhân viên (Phase 1.3) — kho/tải/token dùng lại HrFilesModule (0.4C). */
@Module({
  imports: [
    TypeOrmModule.forFeature([EmployeeDocument, EmployeeDocumentVersion]),
    HrAccessModule,
    HrAuditModule,
    HrEmployeesModule,
    HrFilesModule,
  ],
  controllers: [HrDocumentController],
  providers: [HrDocumentService],
})
export class HrDocumentsModule {}
