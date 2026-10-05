import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HrAccessModule } from '../access/hr-access.module';
import { HrAuditModule } from '../audit/hr-audit.module';
import { HrCryptoModule } from '../crypto/hr-crypto.module';
import { HrEmployeeBankAccount } from './entities/hr-employee-bank-account.entity';
import { HrEmployeeIdentityDocument } from './entities/hr-employee-identity-document.entity';
import { HrEmployeeInsuranceProfile } from './entities/hr-employee-insurance-profile.entity';
import { HrEmployeeTaxProfile } from './entities/hr-employee-tax-profile.entity';
import { HrEmployee } from './entities/hr-employee.entity';
import { HrEmployeeSensitiveController } from './hr-employee-sensitive.controller';
import { HrEmployeeSensitiveService } from './hr-employee-sensitive.service';
import { HrEmployeeController } from './hr-employee.controller';
import { HrEmployeeService } from './hr-employee.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      HrEmployee,
      HrEmployeeIdentityDocument,
      HrEmployeeBankAccount,
      HrEmployeeTaxProfile,
      HrEmployeeInsuranceProfile,
    ]),
    HrAccessModule,
    HrAuditModule,
    HrCryptoModule,
  ],
  controllers: [HrEmployeeController, HrEmployeeSensitiveController],
  providers: [HrEmployeeService, HrEmployeeSensitiveService],
  exports: [HrEmployeeService],
})
export class HrEmployeesModule {}
