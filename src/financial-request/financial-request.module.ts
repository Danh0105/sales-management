import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CashAccount } from '../cashflow-report/cash-account.entity';
import { Department } from '../department/department.entity';
import { Employee } from '../employee/employee.entity';
import { NotificationModule } from '../notifications/notification.module';
import { Payroll } from '../payroll/entities/payroll.entity';
import { FinancialAdvanceAllocation } from './entities/financial-advance-allocation.entity';
import { FinancialApprovalDelegation } from './entities/financial-approval-delegation.entity';
import { FinancialApprovalStep } from './entities/financial-approval-step.entity';
import { FinancialApprovalWorkflow } from './entities/financial-approval-workflow.entity';
import { FinancialAuditLog } from './entities/financial-audit-log.entity';
import { FinancialCompany } from './entities/financial-company.entity';
import { FinancialPayeeProfile } from './entities/financial-payee-profile.entity';
import { FinancialDocumentSequence } from './entities/financial-document-sequence.entity';
import { FinancialExpenseCategory } from './entities/financial-expense-category.entity';
import { FinancialPayment } from './entities/financial-payment.entity';
import { FinancialPolicy } from './entities/financial-policy.entity';
import { FinancialRefund } from './entities/financial-refund.entity';
import { FinancialRequestAttachment } from './entities/financial-request-attachment.entity';
import { FinancialRequestItem } from './entities/financial-request-item.entity';
import { FinancialRequestSupplier } from './entities/financial-request-supplier.entity';
import { FinancialEmployeeCompany } from './entities/financial-employee-company.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialRoleAssignment } from './entities/financial-role-assignment.entity';
import { FinancialSalaryAdvanceDeduction } from './entities/financial-salary-advance-deduction.entity';
import { FinancialWorkflowStep } from './entities/financial-workflow-step.entity';
import { FinancialAccessService } from './financial-access.service';
import { FinancialConfigService } from './financial-config.service';
import { FinancialLedgerService } from './financial-ledger.service';
import { FinancialNotifyService } from './financial-notify.service';
import { FinancialPdfService } from './financial-pdf.service';
import { FinancialReportService } from './financial-report.service';
import {
  FinancialConfigController,
  FinancialRequestController,
} from './financial-request.controller';
import { FinancialRequestService } from './financial-request.service';

@Module({
  imports: [
    NotificationModule,
    TypeOrmModule.forFeature([
      FinancialCompany,
      FinancialExpenseCategory,
      FinancialApprovalWorkflow,
      FinancialWorkflowStep,
      FinancialRoleAssignment,
      FinancialApprovalDelegation,
      FinancialPolicy,
      FinancialDocumentSequence,
      FinancialRequest,
      FinancialRequestItem,
      FinancialRequestSupplier,
      FinancialApprovalStep,
      FinancialPayment,
      FinancialRefund,
      FinancialRequestAttachment,
      FinancialAdvanceAllocation,
      FinancialSalaryAdvanceDeduction,
      FinancialAuditLog,
      FinancialPayeeProfile,
      FinancialEmployeeCompany,
      Employee,
      Department,
      Payroll,
      CashAccount,
    ]),
  ],
  // Thứ tự quan trọng: config trước để `/financial-requests/config` không khớp `/:id`.
  controllers: [FinancialConfigController, FinancialRequestController],
  providers: [
    FinancialAccessService,
    FinancialNotifyService,
    FinancialLedgerService,
    FinancialRequestService,
    FinancialReportService,
    FinancialPdfService,
    FinancialConfigService,
  ],
  // Tổng hợp thu chi xoá phiếu từ sổ: cần trả lại phần đối trừ của tạm ứng.
  exports: [FinancialLedgerService],
})
export class FinancialRequestModule {}
