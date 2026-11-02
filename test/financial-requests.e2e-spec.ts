/**
 * Kiểm thử tích hợp phân hệ Đề nghị tài chính trên Postgres THẬT.
 *
 * Chỉ chạy khi đặt `FINANCIAL_IT_DB` = tên một database test riêng (đã chạy
 * migration 1794500000000). Guard trong test/setup chặn mọi kết nối tới
 * `sales_db`. Mỗi lần chạy tạo công ty/nhân viên mới có hậu tố riêng nên chạy
 * lại nhiều lần không đụng nhau. Không dùng dữ liệu thật.
 *
 *   FINANCIAL_IT_DB=sales_fin_test DB_USER=... DB_PASSWORD=... \
 *     npx jest --config ./test/jest-e2e.json test/financial-requests.e2e-spec.ts
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import * as ExcelJS from 'exceljs';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { CashAccount } from '../src/cashflow-report/cash-account.entity';
import { SourceDeletionService } from '../src/cashflow-report/source-deletion.service';
import { Department } from '../src/department/department.entity';
import { Employee } from '../src/employee/employee.entity';
import { FinancialAdvanceAllocation } from '../src/financial-request/entities/financial-advance-allocation.entity';
import { FinancialApprovalDelegation } from '../src/financial-request/entities/financial-approval-delegation.entity';
import { FinancialApprovalStep } from '../src/financial-request/entities/financial-approval-step.entity';
import { FinancialApprovalWorkflow } from '../src/financial-request/entities/financial-approval-workflow.entity';
import { FinancialAuditLog } from '../src/financial-request/entities/financial-audit-log.entity';
import { FinancialCompany } from '../src/financial-request/entities/financial-company.entity';
import { FinancialDocumentSequence } from '../src/financial-request/entities/financial-document-sequence.entity';
import { FinancialExpenseCategory } from '../src/financial-request/entities/financial-expense-category.entity';
import { FinancialPayment } from '../src/financial-request/entities/financial-payment.entity';
import { FinancialPolicy } from '../src/financial-request/entities/financial-policy.entity';
import { FinancialRefund } from '../src/financial-request/entities/financial-refund.entity';
import { FinancialRequestAttachment } from '../src/financial-request/entities/financial-request-attachment.entity';
import { FinancialRequestItem } from '../src/financial-request/entities/financial-request-item.entity';
import { FinancialRequest } from '../src/financial-request/entities/financial-request.entity';
import { FinancialRoleAssignment } from '../src/financial-request/entities/financial-role-assignment.entity';
import { FinancialSalaryAdvanceDeduction } from '../src/financial-request/entities/financial-salary-advance-deduction.entity';
import { FinancialWorkflowStep } from '../src/financial-request/entities/financial-workflow-step.entity';
import { FinancialAccessService } from '../src/financial-request/financial-access.service';
import { FinancialConfigService } from '../src/financial-request/financial-config.service';
import { FinancialLedgerService } from '../src/financial-request/financial-ledger.service';
import { FinancialNotifyService } from '../src/financial-request/financial-notify.service';
import { FinancialPdfService } from '../src/financial-request/financial-pdf.service';
import { FinancialReportService } from '../src/financial-request/financial-report.service';
import {
  ApprovalStatus,
  AttachmentKind,
  DeductionStatus,
  FinanceRole,
  FinancialRequestType,
  PaymentMethod,
  PaymentStatus,
  RecoveryStatus,
  SelfApprovalMode,
  SettlementStatus,
  StepStatus,
} from '../src/financial-request/financial-request.constants';
import { FinancialRequestService } from '../src/financial-request/financial-request.service';
import { NotificationService } from '../src/notifications/services/notification.service';
import { Payroll } from '../src/payroll/entities/payroll.entity';
import { AuthUser } from '../src/type/auth-user.type';

const DB = process.env.FINANCIAL_IT_DB;
const suite = DB ? describe : describe.skip;

jest.setTimeout(120_000);

const ENTITIES = [
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
  FinancialApprovalStep,
  FinancialPayment,
  FinancialRefund,
  FinancialRequestAttachment,
  FinancialAdvanceAllocation,
  FinancialSalaryAdvanceDeduction,
  FinancialAuditLog,
  Employee,
  Department,
  Payroll,
  CashAccount,
];

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
  'latin1',
);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

function file(name: string, buffer: Buffer): Express.Multer.File {
  return {
    originalname: name,
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

suite('Đề nghị tài chính — tích hợp trên Postgres', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let requests: FinancialRequestService;
  let ledger: FinancialLedgerService;
  let config: FinancialConfigService;
  let reports: FinancialReportService;
  let pdf: FinancialPdfService;
  let deletion: SourceDeletionService;
  const notification = { create: jest.fn().mockResolvedValue({}) };
  const run = Date.now().toString(36);
  const storageDir = mkdtempSync(join(tmpdir(), 'fin-it-'));
  let key = 0;
  const idem = () => `it-${run}-${++key}`;

  const U: Record<string, AuthUser> = {};
  let companyX = 0;
  let companyY = 0;
  let dept1 = 0;

  async function employee(
    label: string,
    roles: string[],
    departmentId: number,
  ) {
    const [row] = await ds.query(
      `INSERT INTO employee (name, phone, roles, department_id, bank_account_number, bank_name)
       VALUES ($1, $2, $3, $4, $5, 'MB Bank') RETURNING id`,
      [
        `${label} ${run}`,
        `09${run}${label}`.slice(0, 20),
        roles,
        departmentId,
        `99${run}${label.length}`,
      ],
    );
    U[label] = { id: row.id, roles, name: `${label} ${run}` };
  }

  const byId = (id: number) => Object.values(U).find((u) => u.id === id);

  /** Đặt FIN_IT_PDF_DIR để lưu PDF mẫu ra xem bằng mắt. */
  async function dumpPdf(name: string, id: number) {
    if (!process.env.FIN_IT_PDF_DIR) return;
    const { buffer } = await pdf.render(U.A, id);
    writeFileSync(join(process.env.FIN_IT_PDF_DIR, `${name}.pdf`), buffer);
  }

  /** Duyệt hết các bước còn chờ bằng người duyệt hợp lệ đầu tiên của mỗi bước. */
  async function approveAll(id: number, comment = 'Đồng ý') {
    for (let guard = 0; guard < 10; guard += 1) {
      const detail = await requests.detail(U.D, id);
      if (detail.approvalStatus !== ApprovalStatus.PENDING) return detail;
      const step = detail.steps.find(
        (s) =>
          s.round === detail.currentRound && s.status === StepStatus.PENDING,
      )!;
      const approver = step.candidates.map((c) => byId(c.id)).find(Boolean);
      if (!approver)
        throw new Error(`Không có người duyệt test cho bước ${step.name}`);
      await requests.approve(approver, id, { stepId: step.id, comment });
    }
    throw new Error('Quá số vòng duyệt');
  }

  async function newAdvance(
    amount: number,
    requester = U.A,
    companyId = companyX,
  ) {
    return requests.create(requester, {
      type: FinancialRequestType.ADVANCE,
      companyId,
      title: 'Tạm ứng đi công tác',
      directManagerId: companyId === companyX ? U.M.id : undefined,
      bankName: 'MB Bank',
      bankAccountNumber: '0123456789',
      items: [
        {
          description: 'Chi phí công tác',
          quantity: '1',
          unitPrice: String(amount),
        },
      ],
    });
  }

  async function paidAdvance(amount: number) {
    const advance = await newAdvance(amount);
    await requests.submit(U.A, advance.id);
    await approveAll(advance.id);
    await ledger.recordPayment(
      advance.id,
      {
        amount,
        date: '2026-10-01',
        method: PaymentMethod.BANK_TRANSFER,
        cashAccountCode: '1121',
        idempotencyKey: idem(),
      },
      U.T,
    );
    return advance;
  }

  async function newSettlement(
    advanceId: number,
    allocation: number,
    expense: number,
  ) {
    return requests.create(U.A, {
      type: FinancialRequestType.SETTLEMENT,
      companyId: companyX,
      title: 'Hoàn ứng công tác',
      directManagerId: U.M.id,
      items: [
        {
          description: 'Chi phí thực tế',
          quantity: '1',
          unitPrice: String(expense),
        },
      ],
      allocations: [{ advanceId, amount: allocation }],
    });
  }

  beforeAll(async () => {
    process.env.FINANCIAL_STORAGE_DIR = storageDir;
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT || 5432),
          username: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: DB,
          entities: [join(__dirname, '../src/**/*.entity.ts')],
          synchronize: false,
        }),
        TypeOrmModule.forFeature(ENTITIES),
      ],
      providers: [
        FinancialAccessService,
        FinancialNotifyService,
        FinancialLedgerService,
        FinancialRequestService,
        FinancialConfigService,
        FinancialReportService,
        FinancialPdfService,
        SourceDeletionService,
        { provide: NotificationService, useValue: notification },
      ],
    }).compile();
    ds = moduleRef.get(getDataSourceToken());
    requests = moduleRef.get(FinancialRequestService);
    ledger = moduleRef.get(FinancialLedgerService);
    config = moduleRef.get(FinancialConfigService);
    reports = moduleRef.get(FinancialReportService);
    pdf = moduleRef.get(FinancialPdfService);
    deletion = moduleRef.get(SourceDeletionService);

    [{ id: dept1 }] = await ds.query(
      `INSERT INTO department (name) VALUES ($1) RETURNING id`,
      [`FIN-IT ${run} Kinh doanh`],
    );
    await employee('A', ['sales'], dept1); // người đề nghị
    await employee('B', ['sales'], dept1); // người đề nghị khác
    await employee('M', ['sales'], dept1); // quản lý trực tiếp
    await employee('C', ['accountant'], dept1); // kiểm soát
    await employee('K', ['accountant'], dept1); // kế toán công ty X
    await employee('K2', ['accountant'], dept1); // kế toán công ty Y
    await employee('D', ['director'], dept1); // BGĐ — quản trị ngầm định
    await employee('T', ['thuquy'], dept1); // thủ quỹ — ngầm định
    await employee('O', ['sales'], dept1); // người ngoài
    await ds.query(
      `INSERT INTO cash_accounts (code, name, "groupCode") VALUES
         ('1111', 'Tiền mặt tại quỹ', '111'),
         ('1121', 'Tiền gửi ngân hàng', '112')
       ON CONFLICT (code) DO NOTHING`,
    );
    await ds.query(
      `INSERT INTO payrolls (employee_id, employee_name, month, year, base_salary, net_salary, created_by_id)
       VALUES ($1, $2, 9, 2026, 10000000, 9000000, $1)`,
      [U.A.id, U.A.name],
    );

    companyX = (
      await config.createCompany(U.D, {
        code: `X${run}`.slice(0, 30),
        name: 'Công ty Thử nghiệm X',
        taxCode: '0101234567',
        address: 'Số 1 Đường Thử, Quận 1, TP.HCM',
        formCodes: { ADVANCE: 'BM-TC01', SETTLEMENT: 'BM-TC03' },
      })
    ).id;
    companyY = (
      await config.createCompany(U.D, {
        code: `Y${run}`.slice(0, 30),
        name: 'Công ty Thử nghiệm Y',
      })
    ).id;
    const assign = (
      label: string,
      role: FinanceRole,
      companyId: number,
      departmentId?: number,
    ) =>
      config.createAssignment(U.D, {
        employeeId: U[label].id,
        role,
        companyId,
        departmentId,
      });
    await assign('M', FinanceRole.MANAGER, companyX, dept1);
    await assign('C', FinanceRole.CONTROLLER, companyX);
    await assign('K', FinanceRole.ACCOUNTANT, companyX);
    await assign('M', FinanceRole.MANAGER, companyY, dept1);
    await assign('C', FinanceRole.CONTROLLER, companyY);
    await assign('K2', FinanceRole.ACCOUNTANT, companyY);
    await config.savePolicy(U.D, {
      companyId: companyX,
      salaryAdvanceMaxPerMonth: 1,
      salaryAdvanceMaxPercent: 50,
      maxDeductionPeriods: 3,
      advanceDueDays: 15,
    });
  });

  afterAll(async () => {
    await moduleRef?.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  let advanceId = 0;

  it('1. Nhân viên tạo đề nghị tạm ứng (nháp, số tiền do backend tính)', async () => {
    const created = await requests.create(U.A, {
      type: FinancialRequestType.ADVANCE,
      companyId: companyX,
      title: 'Tạm ứng mua vật tư sự kiện',
      directManagerId: U.M.id,
      bankName: 'MB Bank',
      bankAccountNumber: '0123456789',
      items: [
        {
          description: 'Băng rôn',
          unit: 'cái',
          quantity: '2',
          unitPrice: '1500000',
        },
        {
          description: 'Nước uống',
          unit: 'thùng',
          quantity: '1.5',
          unitPrice: '33333.33',
        },
      ],
    });
    advanceId = created.id;
    expect(created.code).toMatch(/^TU-\d{4}-\d{5}$/);
    expect(created.approvalStatus).toBe(ApprovalStatus.DRAFT);
    expect(created.items.map((i) => i.amount)).toEqual([3_000_000, 50_000]); // 19. làm tròn
    expect(created.totalAmount).toBe(3_050_000);
    expect(created.summary.amountInWords).toBe(
      'Ba triệu không trăm năm mươi nghìn đồng',
    );
    expect(created.directManagerName).toBe(U.M.name);
  });

  it('2. Lưu nháp rồi chỉnh sửa (khoá lạc quan theo version)', async () => {
    const before = await requests.detail(U.A, advanceId);
    const updated = await requests.update(U.A, advanceId, {
      version: before.version,
      title: 'Tạm ứng mua vật tư sự kiện tháng 11',
      items: [
        {
          id: before.items[0].id,
          description: 'Băng rôn',
          unit: 'cái',
          quantity: '2',
          unitPrice: '2000000',
        },
      ],
    });
    expect(updated.totalAmount).toBe(4_000_000);
    expect(updated.items).toHaveLength(1);
    await expect(
      requests.update(U.A, advanceId, {
        version: before.version,
        title: 'Bản cũ',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      requests.update(U.O, advanceId, {
        version: updated.version,
        title: 'Người ngoài sửa',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('3 + 5. Gửi duyệt qua nhiều cấp, đúng thứ tự, người không có quyền bị chặn', async () => {
    const submitted = await requests.submit(U.A, advanceId);
    expect(submitted.approvalStatus).toBe(ApprovalStatus.PENDING);
    expect(submitted.settlementDueDate).toBeTruthy(); // hạn mặc định theo chính sách
    const round = submitted.steps.filter(
      (s) => s.round === submitted.currentRound,
    );
    expect(round.map((s) => s.status)).toEqual([
      StepStatus.PENDING,
      StepStatus.WAITING,
      StepStatus.WAITING,
      StepStatus.WAITING,
    ]);
    expect(notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receiverId: U.M.id,
        meta: expect.objectContaining({
          route: `/finance/requests/${advanceId}`,
        }),
      }),
    );

    // Duyệt sai thứ tự: kế toán bấm bước 3 khi bước 1 chưa xong.
    await expect(
      requests.approve(U.K, advanceId, { stepId: round[2].id }),
    ).rejects.toBeInstanceOf(ConflictException);
    // Người ngoài / chính người đề nghị không duyệt được.
    await expect(
      requests.approve(U.O, advanceId, { stepId: round[0].id }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      requests.approve(U.A, advanceId, { stepId: round[0].id }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Quản lý trực tiếp thấy phiếu ở "Chờ tôi duyệt".
    const inbox = await requests.list(U.M, { scope: 'approvals' });
    expect(inbox.data.map((r) => r.id)).toContain(advanceId);

    await requests.approve(U.M, advanceId, {
      stepId: round[0].id,
      comment: 'OK',
    });
    // Bấm lặp cùng bước → từ chối, không duyệt hai lần.
    await expect(
      requests.approve(U.M, advanceId, { stepId: round[0].id }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Kiểm soát điều chỉnh số chấp nhận (bắt buộc lý do khi khác số kê khai).
    const atControl = await requests.detail(U.C, advanceId);
    const controlStep = atControl.steps.find((s) => s.id === round[1].id)!;
    expect(controlStep.status).toBe(StepStatus.PENDING);
    await expect(
      requests.approve(U.C, advanceId, {
        stepId: controlStep.id,
        adjustments: [
          { itemId: atControl.items[0].id, approvedAmount: 3_500_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await requests.approve(U.C, advanceId, {
      stepId: controlStep.id,
      adjustments: [
        {
          itemId: atControl.items[0].id,
          approvedAmount: 3_500_000,
          reason: 'Theo báo giá',
        },
      ],
    });
    const approved = await approveAll(advanceId);
    expect(approved.approvalStatus).toBe(ApprovalStatus.APPROVED);
    expect(approved.approvedAmount).toBe(3_500_000);
    expect(approved.paymentStatus).toBe(PaymentStatus.UNPAID);
    expect(approved.settlementStatus).toBe(SettlementStatus.NONE); // chưa chi thì chưa có công nợ
  });

  it('4. Từ chối và yêu cầu bổ sung (vòng duyệt mới, lịch sử giữ nguyên)', async () => {
    const returned = await newAdvance(1_000_000);
    await requests.submit(U.A, returned.id);
    let d = await requests.detail(U.M, returned.id);
    await expect(
      requests.returnForChanges(U.M, returned.id, {
        stepId: d.permissions.actionableStepId!,
        comment: '',
      } as never),
    ).rejects.toBeTruthy();
    await requests.returnForChanges(U.M, returned.id, {
      stepId: d.permissions.actionableStepId!,
      comment: 'Bổ sung báo giá',
    });
    d = await requests.detail(U.A, returned.id);
    expect(d.approvalStatus).toBe(ApprovalStatus.RETURNED);
    expect(d.permissions.canEdit).toBe(true);
    await requests.update(U.A, returned.id, {
      version: d.version,
      purpose: 'Đã bổ sung báo giá',
    });
    const resubmitted = await requests.submit(U.A, returned.id);
    expect(resubmitted.currentRound).toBe(2);
    expect(
      resubmitted.steps.filter((s) => s.round === 1).map((s) => s.status),
    ).toEqual([
      StepStatus.RETURNED,
      StepStatus.CANCELLED,
      StepStatus.CANCELLED,
      StepStatus.CANCELLED,
    ]);

    await requests.reject(U.M, returned.id, {
      stepId:
        resubmitted.permissions.actionableStepId ??
        resubmitted.steps.find(
          (s) => s.round === 2 && s.status === StepStatus.PENDING,
        )!.id,
      comment: 'Không cần thiết',
    });
    const rejected = await requests.detail(U.A, returned.id);
    expect(rejected.approvalStatus).toBe(ApprovalStatus.REJECTED);
    expect(rejected.permissions.canEdit).toBe(false);
    expect(rejected.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'CREATED',
        'SUBMITTED',
        'RETURNED',
        'UPDATED',
        'REJECTED',
      ]),
    );
  });

  it('Thu hồi khi chưa duyệt xong → về nháp', async () => {
    const draft = await newAdvance(500_000);
    await requests.submit(U.A, draft.id);
    const withdrawn = await requests.withdraw(U.A, draft.id, {
      reason: 'Nhập nhầm',
    });
    expect(withdrawn.approvalStatus).toBe(ApprovalStatus.DRAFT);
    expect(
      withdrawn.steps.every((s) => s.status === StepStatus.CANCELLED),
    ).toBe(true);
    await requests.remove(U.A, draft.id);
    await expect(requests.detail(U.A, draft.id)).rejects.toBeTruthy();
  });

  it('6 + 13. Chi một phần rồi toàn bộ; gửi lặp không chi trùng', async () => {
    // Quản lý trực tiếp không có quyền chi.
    await expect(
      ledger.recordPayment(
        advanceId,
        {
          amount: 1,
          date: '2026-10-02',
          method: PaymentMethod.BANK_TRANSFER,
          cashAccountCode: '1121',
          idempotencyKey: idem(),
        },
        U.M,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Thủ quỹ phải chọn tài khoản thanh toán, đúng nhóm với hình thức chi.
    await expect(
      ledger.recordPayment(
        advanceId,
        {
          amount: 1,
          date: '2026-10-02',
          method: PaymentMethod.BANK_TRANSFER,
          idempotencyKey: idem(),
        },
        U.T,
      ),
    ).rejects.toThrow('Chọn tài khoản thanh toán');
    await expect(
      ledger.recordPayment(
        advanceId,
        {
          amount: 1,
          date: '2026-10-02',
          method: PaymentMethod.CASH,
          cashAccountCode: '1121',
          idempotencyKey: idem(),
        },
        U.T,
      ),
    ).rejects.toThrow('nhóm 111');

    const key1 = idem();
    const first = await ledger.recordPayment(
      advanceId,
      {
        amount: 2_000_000,
        date: '2026-10-02',
        method: PaymentMethod.BANK_TRANSFER,
        cashAccountCode: '1121',
        idempotencyKey: key1,
      },
      U.T,
    );
    const replay = await ledger.recordPayment(
      advanceId,
      {
        amount: 2_000_000,
        date: '2026-10-02',
        method: PaymentMethod.BANK_TRANSFER,
        cashAccountCode: '1121',
        idempotencyKey: key1,
      },
      U.T,
    );
    expect(replay.id).toBe(first.id);
    let d = await requests.detail(U.A, advanceId);
    expect(d.paidAmount).toBe(2_000_000);
    expect(d.paymentAccountCode).toBe('1121');
    expect(d.paymentStatus).toBe(PaymentStatus.PARTIALLY_PAID);
    expect(d.settlementStatus).toBe(SettlementStatus.NOT_SETTLED);

    // Hai yêu cầu đồng thời, mỗi cái đúng bằng số còn lại → chỉ một cái được ghi.
    const results = await Promise.allSettled([
      ledger.recordPayment(
        advanceId,
        {
          amount: 1_500_000,
          date: '2026-10-03',
          method: PaymentMethod.BANK_TRANSFER,
          cashAccountCode: '1121',
          transactionRef: 'FT1',
          idempotencyKey: idem(),
        },
        U.T,
      ),
      ledger.recordPayment(
        advanceId,
        {
          amount: 1_500_000,
          date: '2026-10-03',
          method: PaymentMethod.BANK_TRANSFER,
          cashAccountCode: '1121',
          transactionRef: 'FT2',
          idempotencyKey: idem(),
        },
        U.K,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    d = await requests.detail(U.A, advanceId);
    expect(d.paidAmount).toBe(3_500_000);
    expect(d.paymentStatus).toBe(PaymentStatus.PAID);
    await expect(
      ledger.recordPayment(
        advanceId,
        {
          amount: 1,
          date: '2026-10-03',
          method: PaymentMethod.BANK_TRANSFER,
          cashAccountCode: '1121',
          idempotencyKey: idem(),
        },
        U.T,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('7 + 8. Hoàn ứng chi phí LỚN hơn tạm ứng → công ty trả thêm rồi mới quyết toán xong', async () => {
    const settlement = await newSettlement(advanceId, 3_500_000, 4_200_000);
    expect(settlement.code).toMatch(/^HU-/);
    expect(settlement.offsetAmount).toBe(3_500_000);
    await requests.submit(U.A, settlement.id);
    const approved = await approveAll(settlement.id);
    expect(approved.summary.difference).toBe(700_000);
    expect(approved.settlementStatus).toBe(SettlementStatus.PENDING_PAYMENT);
    expect(approved.summary.payableRemaining).toBe(700_000);
    let advance = await requests.detail(U.A, advanceId);
    expect(advance.settledAmount).toBe(3_500_000);
    expect(advance.settlementStatus).toBe(SettlementStatus.SETTLED);
    expect(advance.settlements.map((s) => s.settlementId)).toContain(
      settlement.id,
    );

    await ledger.recordPayment(
      settlement.id,
      {
        amount: 700_000,
        date: '2026-10-10',
        method: PaymentMethod.CASH,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      },
      U.T,
    );
    const done = await requests.detail(U.A, settlement.id);
    expect(done.settlementStatus).toBe(SettlementStatus.COMPLETED);
    expect(done.paymentStatus).toBe(PaymentStatus.PAID);
    advance = await requests.detail(U.A, advanceId);
    expect(advance.summary.advanceOutstanding).toBe(0);
  });

  it('9. Hoàn ứng chi phí BẰNG tạm ứng → tất toán ngay khi duyệt', async () => {
    const adv = await paidAdvance(2_000_000);
    const settlement = await newSettlement(adv.id, 2_000_000, 2_000_000);
    await requests.submit(U.A, settlement.id);
    const approved = await approveAll(settlement.id);
    expect(approved.summary.difference).toBe(0);
    expect(approved.settlementStatus).toBe(SettlementStatus.COMPLETED);
    expect(approved.paymentStatus).toBe(PaymentStatus.NONE);
    expect((await requests.detail(U.A, adv.id)).settlementStatus).toBe(
      SettlementStatus.SETTLED,
    );
  });

  it('10. Hoàn ứng chi phí NHỎ hơn tạm ứng → chờ hoàn trả; tạm ứng chỉ tất toán khi thu đủ', async () => {
    const adv = await paidAdvance(5_000_000);
    const settlement = await newSettlement(adv.id, 5_000_000, 3_200_000);
    await requests.submit(U.A, settlement.id);
    const approved = await approveAll(settlement.id);
    expect(approved.summary.difference).toBe(-1_800_000);
    expect(approved.settlementStatus).toBe(SettlementStatus.PENDING_REFUND);
    expect(approved.recoveryStatus).toBe(RecoveryStatus.PENDING);
    // Duyệt xong KHÔNG có nghĩa là tạm ứng đã tất toán.
    expect((await requests.detail(U.A, adv.id)).settlementStatus).toBe(
      SettlementStatus.PARTIALLY_SETTLED,
    );

    await ledger.recordRefund(
      settlement.id,
      {
        amount: 800_000,
        date: '2026-10-11',
        method: PaymentMethod.CASH,
        idempotencyKey: idem(),
      },
      U.T,
    );
    let s = await requests.detail(U.A, settlement.id);
    expect(s.recoveryStatus).toBe(RecoveryStatus.PARTIAL);
    expect(s.summary.receivableRemaining).toBe(1_000_000);
    await expect(
      ledger.recordRefund(
        settlement.id,
        {
          amount: 1_000_001,
          date: '2026-10-12',
          method: PaymentMethod.CASH,
          idempotencyKey: idem(),
        },
        U.T,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await ledger.recordRefund(
      settlement.id,
      {
        amount: 1_000_000,
        date: '2026-10-12',
        method: PaymentMethod.CASH,
        idempotencyKey: idem(),
      },
      U.T,
    );
    s = await requests.detail(U.A, settlement.id);
    expect(s.settlementStatus).toBe(SettlementStatus.COMPLETED);
    await dumpPdf('hoan-ung', settlement.id);
    expect((await requests.detail(U.A, adv.id)).settlementStatus).toBe(
      SettlementStatus.SETTLED,
    );
  });

  it('11 + 12. Hoàn ứng một phần nhiều lần; không cho đối trừ vượt số dư (kể cả gửi đồng thời)', async () => {
    const adv = await paidAdvance(6_000_000);
    const s1 = await newSettlement(adv.id, 2_000_000, 2_000_000);
    await requests.submit(U.A, s1.id);
    await approveAll(s1.id);
    let a = await requests.detail(U.A, adv.id);
    expect(a.settlementStatus).toBe(SettlementStatus.PARTIALLY_SETTLED);
    expect(a.summary.advanceOutstanding).toBe(4_000_000);

    const available = await ledger.availableAdvances(U.A, {
      companyId: companyX,
    });
    expect(available.find((x) => x.id === adv.id)?.available).toBe(4_000_000);
    await expect(
      newSettlement(adv.id, 4_000_001, 4_000_001),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Hai bản nháp cùng muốn đối trừ 4tr còn lại, gửi đồng thời → chỉ một được giữ chỗ.
    const s2 = await newSettlement(adv.id, 4_000_000, 4_000_000);
    const s3 = await newSettlement(adv.id, 4_000_000, 4_000_000);
    const results = await Promise.allSettled([
      requests.submit(U.A, s2.id),
      requests.submit(U.A, s3.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? s2.id : s3.id;
    await approveAll(winner);
    a = await requests.detail(U.A, adv.id);
    expect(a.settledAmount).toBe(6_000_000);
    expect(a.settlementStatus).toBe(SettlementStatus.SETTLED);
    // Tạm ứng đã được đối trừ thì không huỷ phiếu chi được.
    await expect(
      ledger.voidPayment(adv.id, a.payments[0].id, { reason: 'thử' }, U.K),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  let salaryId = 0;

  it('14 + 15. Tạm ứng lương: chính sách, khấu trừ đúng kỳ, không trừ hai lần', async () => {
    const tooMuch = await requests.create(U.A, {
      type: FinancialRequestType.SALARY_ADVANCE,
      companyId: companyX,
      title: 'Ứng lương',
      directManagerId: U.M.id,
      salaryYear: 2026,
      salaryMonth: 10,
      requestedAmount: 6_000_000,
    });
    expect(tooMuch.expectedSalary).toBe(10_000_000);
    await expect(requests.submit(U.A, tooMuch.id)).rejects.toThrow(
      /50% lương dự kiến/,
    );
    await requests.remove(U.A, tooMuch.id);

    const created = await requests.create(U.A, {
      type: FinancialRequestType.SALARY_ADVANCE,
      companyId: companyX,
      title: 'Ứng lương tháng 10',
      directManagerId: U.M.id,
      salaryYear: 2026,
      salaryMonth: 10,
      requestedAmount: 3_000_001,
      deductionPeriods: 2,
    });
    salaryId = created.id;
    expect(created.code).toMatch(/^UL-/);
    expect(created.items[0].description).toBe('Tạm ứng lương tháng 10/2026');
    await requests.submit(U.A, salaryId);
    const approved = await approveAll(salaryId);
    expect(approved.deductions).toHaveLength(0); // chưa chi → chưa có khấu trừ

    // Chính sách 1 lần/tháng.
    const second = await requests.create(U.A, {
      type: FinancialRequestType.SALARY_ADVANCE,
      companyId: companyX,
      title: 'Ứng lần 2',
      directManagerId: U.M.id,
      salaryYear: 2026,
      salaryMonth: 10,
      requestedAmount: 100_000,
    });
    await expect(requests.submit(U.A, second.id)).rejects.toThrow(
      /tối đa 1 lần\/tháng/,
    );

    await ledger.recordPayment(
      salaryId,
      {
        amount: 3_000_001,
        date: '2026-10-05',
        method: PaymentMethod.CASH,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      },
      U.T,
    );
    let d = await requests.detail(U.A, salaryId);
    expect(d.deductionStatus).toBe(DeductionStatus.NOT_DEDUCTED);
    expect(
      d.deductions.map((r) => [r.periodMonth, r.plannedAmount, r.status]),
    ).toEqual([
      [10, 1_500_000, 'PLANNED'],
      [11, 1_500_001, 'PLANNED'],
    ]);
    const preview = await ledger.payrollPreview(U.K, U.A.id, 2026, 10);
    expect(preview.plannedAmount).toBe(1_500_000);

    // Người đề nghị không tự ghi nhận khấu trừ cho mình.
    await expect(
      ledger.confirmDeduction(
        salaryId,
        d.deductions[0].id,
        { idempotencyKey: idem() },
        U.A,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const k = idem();
    await ledger.confirmDeduction(
      salaryId,
      d.deductions[0].id,
      { idempotencyKey: k },
      U.K,
    );
    await ledger.confirmDeduction(
      salaryId,
      d.deductions[0].id,
      { idempotencyKey: k },
      U.K,
    ); // gửi lặp
    await expect(
      ledger.confirmDeduction(
        salaryId,
        d.deductions[0].id,
        { idempotencyKey: idem() },
        U.K,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    d = await requests.detail(U.A, salaryId);
    expect(d.deductedAmount).toBe(1_500_000);
    expect(d.deductionStatus).toBe(DeductionStatus.DEDUCTING);

    // Ràng buộc DB: không thể có 2 dòng cùng kỳ cho một khoản ứng.
    await expect(
      ds.query(
        `INSERT INTO financial_salary_advance_deductions (request_id, employee_id, period_year, period_month, planned_amount, status)
         VALUES ($1, $2, 2026, 10, 1, 'PLANNED')`,
        [salaryId, U.A.id],
      ),
    ).rejects.toThrow(/UQ_financial_salary_advance_deductions_period/);

    await ledger.confirmDeduction(
      salaryId,
      d.deductions[1].id,
      { idempotencyKey: idem() },
      U.K,
    );
    d = await requests.detail(U.A, salaryId);
    expect(d.deductionStatus).toBe(DeductionStatus.DEDUCTED);
    expect(d.deductedAmount).toBe(3_000_001);
  });

  it('16. Xuất PDF tiếng Việt nhiều trang', async () => {
    const many = await requests.create(U.A, {
      type: FinancialRequestType.EXPENSE_PAYMENT,
      companyId: companyX,
      title: 'Thanh toán công tác phí Đà Nẵng — đoàn kiểm tra',
      directManagerId: U.M.id,
      location: 'Đà Nẵng',
      tripStartDate: '2026-10-01',
      tripEndDate: '2026-10-05',
      bankName: 'Vietcombank',
      bankAccountNumber: '0011223344',
      items: Array.from({ length: 80 }, (_, i) => ({
        description: `Chi phí ăn uống, đi lại ngày thứ ${i + 1} — hoá đơn GTGT`,
        unit: 'lần',
        quantity: '1',
        unitPrice: String(150_000 + i * 1000),
        invoiceNumber: `HD${run}${i}`,
      })),
    });
    const { buffer, fileName } = await pdf.render(U.A, many.id);
    expect(fileName).toBe(`${many.code}.pdf`);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(buffer.toString('latin1')).toMatch(/Roboto/); // font Unicode được nhúng
    await dumpPdf('thanh-toan-80-dong', many.id);
    await dumpPdf('tam-ung', advanceId);
  });

  it('17. Xuất Excel đúng số tiền', async () => {
    const list = await requests.list(U.D, {
      scope: 'all',
      companyId: companyX,
      limit: 200,
    });
    const { buffer, count } = await reports.exportList(U.D, {
      scope: 'all',
      companyId: companyX,
    });
    expect(count).toBe(list.meta.total);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.getWorksheet('Đề nghị')!;
    let sum = 0;
    sheet.eachRow((row, index) => {
      if (index === 1 || row.getCell(1).value === 'TỔNG CỘNG') return;
      sum += Number(row.getCell(8).value);
    });
    expect(sum).toBe(list.totals.totalAmount);
    const totalRow = sheet.getRow(sheet.rowCount);
    expect(totalRow.getCell(1).value).toBe('TỔNG CỘNG');
    expect(Number(totalRow.getCell(8).value)).toBe(list.totals.totalAmount);
  });

  it('18. Phân quyền giữa nhiều công ty', async () => {
    const y = await requests.create(U.B, {
      type: FinancialRequestType.ADVANCE,
      companyId: companyY,
      title: 'Tạm ứng công ty Y',
      directManagerId: U.M.id,
      items: [{ description: 'Chi phí', quantity: '1', unitPrice: '1000000' }],
    });
    await requests.submit(U.B, y.id);
    await approveAll(y.id);
    // Kế toán công ty X không xem/chi được phiếu công ty Y.
    await expect(requests.detail(U.K, y.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      ledger.recordPayment(
        y.id,
        {
          amount: 1,
          date: '2026-10-05',
          method: PaymentMethod.CASH,
          cashAccountCode: '1111',
          idempotencyKey: idem(),
        },
        U.K,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const kList = await requests.list(U.K, { scope: 'all' });
    expect(kList.data.map((r) => r.id)).not.toContain(y.id);
    // Kế toán công ty Y thì được; số tài khoản bị che với người không đủ quyền.
    const asK2 = await requests.detail(U.K2, y.id);
    expect(asK2.permissions.canRecordPayment).toBe(true);
    const asOutsider = await requests.list(U.O, { scope: 'all' });
    expect(asOutsider.data.map((r) => r.id)).not.toContain(y.id);
  });

  it('20b. Bộ phận kiểm soát đính kèm chứng từ khi phiếu đang chờ cấp của mình', async () => {
    const req = await newAdvance(400_000);
    await requests.submit(U.A, req.id);
    const control = () =>
      requests.uploadAttachments(
        U.C,
        req.id,
        [file('bien-ban-kiem-soat.pdf', PDF_BYTES)],
        {
          kind: AttachmentKind.CONTROL_EVIDENCE,
        },
      );
    // Chưa tới cấp kiểm soát → chưa được đính kèm.
    await expect(control()).rejects.toBeInstanceOf(ForbiddenException);
    let d = await requests.detail(U.M, req.id);
    await requests.approve(U.M, req.id, {
      stepId: d.permissions.actionableStepId!,
    });

    d = await requests.detail(U.C, req.id);
    expect(d.permissions.isControlStep).toBe(true);
    // Người lập / người ngoài không đính kèm chứng từ kiểm soát.
    await expect(
      requests.uploadAttachments(U.A, req.id, [file('x.pdf', PDF_BYTES)], {
        kind: AttachmentKind.CONTROL_EVIDENCE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const withEvidence = await control();
    expect(
      withEvidence.attachments.filter(
        (a) => a.kind === AttachmentKind.CONTROL_EVIDENCE,
      ),
    ).toHaveLength(1);
    await requests.approve(U.C, req.id, {
      stepId: d.permissions.actionableStepId!,
    });
    // Qua cấp kiểm soát rồi thì thôi.
    await expect(control()).rejects.toBeInstanceOf(ForbiddenException);
    // Kiểm soát không chọn tài khoản — thủ quỹ chọn khi chi tiền.
    const after = await requests.detail(U.A, req.id);
    expect(after.paymentAccountCode).toBeNull();
  });

  it('20. Tệp đính kèm (kiểm tra loại/quyền), nhật ký và lịch sử duyệt', async () => {
    const draft = await newAdvance(300_000);
    await expect(
      requests.uploadAttachments(
        U.A,
        draft.id,
        [file('hoadon.pdf', Buffer.from('MZ\x90\x00 fake exe'))],
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      requests.uploadAttachments(
        U.A,
        draft.id,
        [file('virus.exe', PDF_BYTES)],
        {},
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      requests.uploadAttachments(
        U.O,
        draft.id,
        [file('hoadon.pdf', PDF_BYTES)],
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const withFiles = await requests.uploadAttachments(
      U.A,
      draft.id,
      [file('Hóa đơn tháng 10.pdf', PDF_BYTES), file('anh.png', PNG_BYTES)],
      {
        kind: AttachmentKind.INVOICE,
        itemId: (await requests.detail(U.A, draft.id)).items[0].id,
      },
    );
    expect(withFiles.attachments.map((a) => a.originalName)).toEqual([
      'Hóa đơn tháng 10.pdf',
      'anh.png',
    ]);
    expect(withFiles.items[0].attachmentCount).toBe(2);
    const { attachment } = await requests.attachmentFile(
      U.A,
      draft.id,
      withFiles.attachments[0].id,
    );
    expect(attachment.sha256).toHaveLength(64);
    await expect(
      requests.attachmentFile(U.O, draft.id, withFiles.attachments[0].id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Thủ quỹ thấy mọi phiếu đã gửi, nhưng tệp của bản nháp chưa gửi thì không.
    await expect(
      requests.attachmentFile(U.T, draft.id, withFiles.attachments[0].id),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const history = await requests.detail(U.A, advanceId);
    expect(history.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'CREATED',
        'UPDATED',
        'SUBMITTED',
        'APPROVED_STEP',
        'AMOUNTS_ADJUSTED',
        'APPROVED',
        'PAYMENT_RECORDED',
      ]),
    );
    const approvedSteps = history.steps.filter(
      (s) => s.status === StepStatus.APPROVED,
    );
    expect(approvedSteps.every((s) => s.actedByName && s.actedAt)).toBe(true);
    // Nhật ký bất biến ở tầng DB.
    await expect(
      ds.query(
        `UPDATE financial_audit_logs SET action = 'X' WHERE request_id = $1`,
        [advanceId],
      ),
    ).rejects.toThrow();
    await expect(
      ds.query(`DELETE FROM financial_audit_logs WHERE request_id = $1`, [
        advanceId,
      ]),
    ).rejects.toThrow();
  });

  it('Uỷ quyền duyệt có thời hạn và chặn tự phê duyệt', async () => {
    const req = await newAdvance(200_000, U.B);
    await requests.submit(U.B, req.id);
    const now = Date.now();
    const delegation = await config.createDelegation(U.M, {
      delegateId: U.O.id,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 86_400_000).toISOString(),
      reason: 'Nghỉ phép',
    });
    const inbox = await requests.list(U.O, { scope: 'approvals' });
    expect(inbox.data.map((r) => r.id)).toContain(req.id);
    const d = await requests.detail(U.O, req.id);
    await requests.approve(U.O, req.id, {
      stepId: d.permissions.actionableStepId!,
    });
    const after = await requests.detail(U.D, req.id);
    const managerStep = after.steps.find((s) => s.stepOrder === 1)!;
    expect(managerStep.actedByName).toBe(U.O.name);
    expect(managerStep.onBehalfOfName).toBe(U.M.name);
    await config.revokeDelegation(U.M, delegation.id);
    expect(
      (await requests.list(U.O, { scope: 'approvals' })).data.map((r) => r.id),
    ).not.toContain(req.id);

    // Kiểm soát viên tự lập phiếu: là người kiểm soát duy nhất → chính sách BLOCK không cho gửi.
    const own = await requests.create(U.C, {
      type: FinancialRequestType.EXPENSE_PAYMENT,
      companyId: companyX,
      title: 'Thanh toán của kiểm soát viên',
      directManagerId: U.M.id,
      items: [
        { description: 'Văn phòng phẩm', quantity: '1', unitPrice: '100000' },
      ],
    });
    await expect(requests.submit(U.C, own.id)).rejects.toThrow(
      /Bộ phận kiểm soát/,
    );
    // Quy trình riêng cho công ty X với SKIP_STEP → bỏ qua cấp kiểm soát có ghi lý do.
    await config.createWorkflow(U.D, {
      name: `Quy trình X ${run}`,
      companyId: companyX,
      requestType: FinancialRequestType.EXPENSE_PAYMENT,
      selfApprovalMode: SelfApprovalMode.SKIP_STEP,
      steps: [
        {
          name: 'Quản lý trực tiếp',
          approverType: 'DIRECT_MANAGER' as never,
          signatureSlot: 'MANAGER' as never,
        },
        {
          name: 'Bộ phận kiểm soát',
          approverType: 'ROLE' as never,
          approverRole: FinanceRole.CONTROLLER,
          signatureSlot: 'CONTROLLER' as never,
        },
        {
          name: 'Kế toán',
          approverType: 'ROLE' as never,
          approverRole: FinanceRole.ACCOUNTANT,
          signatureSlot: 'ACCOUNTANT' as never,
        },
      ],
    });
    const submitted = await requests.submit(U.C, own.id);
    expect(submitted.workflowName).toBe(`Quy trình X ${run}`);
    expect(submitted.steps.find((s) => s.stepOrder === 2)?.status).toBe(
      StepStatus.SKIPPED,
    );
  });

  it('Huỷ phiếu đã duyệt chưa chi (bắt buộc lý do), sao chép tạo phiếu mới, dashboard theo quyền', async () => {
    const req = await newAdvance(400_000);
    await requests.submit(U.A, req.id);
    await approveAll(req.id);
    await expect(
      requests.cancel(U.A, req.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const cancelled = await requests.cancel(U.K, req.id, {
      reason: 'Sự kiện bị hoãn',
    });
    expect(cancelled.approvalStatus).toBe(ApprovalStatus.CANCELLED);
    expect(cancelled.cancelReason).toBe('Sự kiện bị hoãn');

    const copy = await requests.copy(U.A, req.id);
    expect(copy.approvalStatus).toBe(ApprovalStatus.DRAFT);
    expect(copy.copiedFromId).toBe(req.id);
    expect(copy.totalAmount).toBe(400_000);

    const summary = await reports.summary(U.D, { companyId: companyX });
    expect(summary.kpis.totalPaid).toBeGreaterThan(0);
    expect(summary.kpis.salaryAdvanceOutstanding).toBe(0);
    expect(summary.kpis.receivable).toBe(0);
    expect(summary.charts.byMonth.length).toBeGreaterThan(0);
    // Nhân viên chỉ thấy số liệu của chính mình.
    const mine = await reports.summary(U.B, { companyId: companyX });
    expect(mine.kpis.totalApproved).toBeLessThan(summary.kpis.totalApproved);

    const balances = await ledger.balances(U.D, { companyId: companyX });
    const rowA = balances.rows.find((r) => r.employeeId === U.A.id);
    expect(rowA?.advanceOutstanding ?? 0).toBe(0);
  });

  it('Giám đốc và trưởng/phó phòng được chọn làm quản lý trực tiếp', async () => {
    await employee('H', ['saleadmin', 'truongphong_saleadmin'], dept1);

    const managers = await requests.eligibleManagers(U.A, companyX);
    const ids = managers.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([U.D.id, U.H.id, U.M.id]));
    expect(ids).not.toContain(U.O.id);
    expect(ids).not.toContain(U.A.id);
    // Giám đốc đứng trước trưởng/phó phòng, rồi tới người được gán MANAGER.
    expect(ids.indexOf(U.D.id)).toBeLessThan(ids.indexOf(U.H.id));
    expect(ids.indexOf(U.H.id)).toBeLessThan(ids.indexOf(U.M.id));
    expect(managers.find((m) => m.id === U.H.id)?.position).toBe(
      'Trưởng/phó phòng sale admin',
    );
    expect((await requests.meta(U.H)).capabilities.canApprove).toBe(true);
    expect((await requests.meta(U.O)).capabilities.canApprove).toBe(false);

    const req = await requests.create(U.A, {
      type: FinancialRequestType.ADVANCE,
      companyId: companyX,
      title: 'Tạm ứng mua văn phòng phẩm',
      directManagerId: U.H.id,
      items: [{ description: 'Giấy in', quantity: '1', unitPrice: '200000' }],
    });
    expect(req.directManagerName).toBe(U.H.name);
    await requests.submit(U.A, req.id);

    const inbox = await requests.list(U.H, { scope: 'approvals' });
    expect(inbox.data.map((r) => r.id)).toContain(req.id);
    const detail = await requests.detail(U.H, req.id);
    const step = detail.steps.find(
      (s) => s.round === detail.currentRound && s.status === StepStatus.PENDING,
    )!;
    expect(step.candidates.map((c) => c.id)).toEqual([U.H.id]);
    await requests.approve(U.H, req.id, { stepId: step.id });

    // Không suy ra vai trò MANAGER: không xem được phiếu không ghi tên mình.
    await expect(requests.detail(U.H, advanceId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      requests.create(U.A, {
        type: FinancialRequestType.ADVANCE,
        companyId: companyX,
        title: 'Chọn người không phải quản lý',
        directManagerId: U.O.id,
        items: [{ description: 'x', quantity: '1', unitPrice: '1000' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  let dept2 = 0;

  it('Vai trò Nhân viên: xếp vào phòng ban → phiếu mới chọn sẵn quản lý trực tiếp của phòng ban', async () => {
    // Phòng 1: M được gán Quản lý trực tiếp riêng phòng 1, đứng trước trưởng phòng H.
    const forA = await requests.eligibleManagers(U.A, companyX);
    expect(forA.filter((m) => m.isDefault).map((m) => m.id)).toEqual([U.M.id]);
    // Chính M lập phiếu thì không tự chọn mình — tới lượt trưởng phòng.
    const forM = await requests.eligibleManagers(U.M, companyX);
    expect(forM.find((m) => m.isDefault)?.id).toBe(U.H.id);

    [{ id: dept2 }] = await ds.query(
      `INSERT INTO department (name) VALUES ($1) RETURNING id`,
      [`FIN-IT ${run} Kế toán`],
    );
    await employee('P', ['accountant', 'truongphong_ketoan'], dept2);
    await employee('S', ['employee'], dept1);
    const moved = await config.setEmployeeDepartment(U.D, U.S.id, {
      departmentId: dept2,
    });
    expect(moved).toMatchObject({ employeeId: U.S.id, departmentId: dept2 });
    // Phòng 2 chỉ có trưởng phòng → mặc định trưởng phòng.
    const forS = await requests.eligibleManagers(U.S, companyX);
    expect(forS.find((m) => m.isDefault)?.id).toBe(U.P.id);

    const overview = await config.overview(U.D);
    const managersOf = (id: number) =>
      overview.departments.find((d) => d.id === id)?.managers.map((m) => m.id);
    expect(managersOf(dept1)).toEqual([U.M.id, U.H.id]);
    expect(managersOf(dept2)).toEqual([U.P.id]);

    // Gán Quản lý trực tiếp riêng phòng 2 ở công ty X → đứng trước trưởng phòng,
    // chỉ trong công ty X.
    await config.createAssignment(U.D, {
      employeeId: U.B.id,
      role: FinanceRole.MANAGER,
      companyId: companyX,
      departmentId: dept2,
    });
    const afterAssign = await requests.eligibleManagers(U.S, companyX);
    expect(afterAssign.find((m) => m.isDefault)?.id).toBe(U.B.id);
    const inCompanyY = await requests.eligibleManagers(U.S, companyY);
    expect(inCompanyY.find((m) => m.isDefault)?.id).toBe(U.P.id);

    // Phiếu lập sau khi chuyển phòng mang phòng ban mới.
    const req = await requests.create(U.S, {
      type: FinancialRequestType.ADVANCE,
      companyId: companyX,
      title: 'Tạm ứng của nhân viên phòng 2',
      directManagerId: U.B.id,
      items: [{ description: 'Mực in', quantity: '1', unitPrice: '150000' }],
    });
    expect(req.departmentId).toBe(dept2);

    // Gán lại đúng phòng hiện tại không ghi thêm nhật ký.
    await config.setEmployeeDepartment(U.D, U.S.id, { departmentId: dept2 });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM financial_audit_logs
        WHERE entity_type = 'EMPLOYEE' AND entity_id = $1 AND action = 'EMPLOYEE_DEPARTMENT_CHANGED'`,
      [U.S.id],
    );
    expect(n).toBe(1);
    await expect(
      config.setEmployeeDepartment(U.A, U.S.id, { departmentId: dept1 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      config.setEmployeeDepartment(U.D, U.S.id, {
        departmentId: 2_000_000_000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('Tạo tài khoản nhân viên ở màn Phân quyền: role employee, đúng phòng ban', async () => {
    const phone = `08${String(Date.now()).slice(-9)}`;
    const account = await config.createAccount(U.D, {
      name: 'Nhân viên mới IT',
      phone,
      password: 'matkhau123',
      departmentId: dept2,
    });
    expect(account).toMatchObject({ departmentId: dept2 });
    const [row] = await ds.query(
      `SELECT roles, department_id, email, password FROM employee WHERE id = $1`,
      [account.id],
    );
    expect(row.roles).toEqual(['employee']);
    expect(row.department_id).toBe(dept2);
    expect(row.email).toBeNull();
    expect(await bcrypt.compare('matkhau123', row.password)).toBe(true);

    // Tài khoản mới lập phiếu → mặc định quản lý trực tiếp của phòng 2.
    const newcomer = {
      id: account.id,
      roles: ['employee'],
      name: account.name,
    };
    const managers = await requests.eligibleManagers(newcomer, companyX);
    expect(managers.find((m) => m.isDefault)?.id).toBe(U.B.id);

    await expect(
      config.createAccount(U.D, {
        name: 'Trùng số',
        phone,
        password: 'matkhau123',
        departmentId: dept1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Quản trị phân hệ nhưng không phải giám đốc/nhân sự: không cấp tài khoản.
    const admin = await config.createAssignment(U.D, {
      employeeId: U.K.id,
      role: FinanceRole.ADMIN,
    });
    expect((await config.overview(U.K)).canCreateAccount).toBe(false);
    await expect(
      config.createAccount(U.K, {
        name: 'Không được tạo',
        phone: `07${String(Date.now()).slice(-9)}`,
        password: 'matkhau123',
        departmentId: dept1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await config.removeAssignment(U.D, admin.id);
    expect((await config.overview(U.D)).canCreateAccount).toBe(true);
  });

  it('Lưu và sửa thông tin nhận tiền của chính mình (không sửa hồ sơ nhân viên)', async () => {
    expect((await requests.meta(U.B)).me.savedPayee).toBeNull();
    const saved = await requests.savePayeeProfile(U.B, {
      payeeName: '  Người nhận B ',
      bankAccountHolder: 'NGUOI NHAN B',
      bankName: 'VCB',
      bankAccountNumber: '0011223344',
    });
    expect(saved).toMatchObject({
      payeeName: 'Người nhận B',
      bankName: 'VCB',
      bankAccountNumber: '0011223344',
    });
    // Sửa: ghi đè đúng một dòng của người đó.
    await requests.savePayeeProfile(U.B, {
      payeeName: 'Người nhận B',
      bankAccountHolder: 'NGUOI NHAN B',
      bankName: 'MB Bank',
      bankAccountNumber: '9988776655',
    });
    expect((await requests.meta(U.B)).me.savedPayee).toMatchObject({
      bankName: 'MB Bank',
      bankAccountNumber: '9988776655',
    });
    const [{ n }] = await ds.query(
      `SELECT count(*)::int AS n FROM financial_payee_profiles WHERE employee_id = $1`,
      [U.B.id],
    );
    expect(n).toBe(1);
    // Mỗi người một bản; tài khoản trong hồ sơ nhân viên (bảng lương) giữ nguyên.
    expect((await requests.meta(U.O)).me.savedPayee).toBeNull();
    const meB = (await requests.meta(U.B)).me;
    expect(meB.bankAccountNumber).not.toBe('9988776655');
  });

  const countRows = async (sql: string, params: unknown[]) =>
    Number((await ds.query(sql, params))[0].n);

  it('Xoá từ Tổng hợp thu chi: tạm ứng đã chi + phiếu hoàn ứng đối trừ → xoá hẳn cả hai', async () => {
    const adv = await paidAdvance(1_000_000);
    const settlement = await newSettlement(adv.id, 1_000_000, 1_000_000);
    await requests.submit(U.A, settlement.id);
    await approveAll(settlement.id);
    expect((await requests.detail(U.A, adv.id)).settledAmount).toBe(1_000_000);
    await ds.query(
      `INSERT INTO notification (type, "receiverId", "entityId", message) VALUES ('FINANCIAL_REQUEST', $1, $2, 'it')`,
      [U.A.id, adv.id],
    );

    const plan = await deletion.plan('FINANCIAL_REQUEST', adv.id);
    expect(plan).toMatchObject({ mode: 'DELETE', blockers: [] });
    const listed = plan.items.join('\n');
    expect(listed).toContain(adv.code);
    expect(listed).toContain(`Phiếu hoàn ứng đối trừ tạm ứng này: Hoàn ứng ${settlement.code}`);
    expect(listed).toContain('1 lần chi tiền (1.000.000 đ)');

    await deletion.execute('FINANCIAL_REQUEST', adv.id, U.T);
    const ids = [adv.id, settlement.id];
    expect(await countRows(`SELECT count(*) AS n FROM financial_requests WHERE id = ANY($1)`, [ids])).toBe(0);
    expect(await countRows(`SELECT count(*) AS n FROM financial_payments WHERE request_id = ANY($1)`, [ids])).toBe(0);
    expect(await countRows(`SELECT count(*) AS n FROM financial_advance_allocations WHERE advance_id = ANY($1) OR settlement_id = ANY($1)`, [ids])).toBe(0);
    expect(await countRows(`SELECT count(*) AS n FROM notification WHERE type = 'FINANCIAL_REQUEST' AND "entityId" = ANY($1)`, [ids])).toBe(0);
    // Nhật ký kiểm toán giữ lại + ghi người xoá.
    expect(await countRows(`SELECT count(*) AS n FROM financial_audit_logs WHERE request_id = ANY($1) AND action = 'DELETED' AND actor_id = $2`, [ids, U.T.id])).toBe(2);
    expect(await countRows(`SELECT count(*) AS n FROM financial_audit_logs WHERE request_id = $1 AND action = 'PAYMENT_RECORDED'`, [adv.id])).toBe(1);
    await expect(requests.detail(U.A, adv.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(deletion.plan('FINANCIAL_REQUEST', adv.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Xoá phiếu hoàn ứng từ sổ → trả lại phần đối trừ cho các tạm ứng còn giữ', async () => {
    const a1 = await paidAdvance(600_000);
    const a2 = await paidAdvance(400_000);
    const before = (await requests.detail(U.A, a1.id)).settlementStatus;
    const settlement = await requests.create(U.A, {
      type: FinancialRequestType.SETTLEMENT,
      companyId: companyX,
      title: 'Hoàn ứng gộp hai tạm ứng',
      directManagerId: U.M.id,
      items: [{ description: 'Chi phí thực tế', quantity: '1', unitPrice: '1200000' }],
      allocations: [
        { advanceId: a1.id, amount: 600_000 },
        { advanceId: a2.id, amount: 400_000 },
      ],
    });
    await requests.submit(U.A, settlement.id);
    await approveAll(settlement.id);
    await ledger.recordPayment(
      settlement.id,
      { amount: 200_000, date: '2026-10-12', method: PaymentMethod.CASH, cashAccountCode: '1111', idempotencyKey: idem() },
      U.T,
    );
    expect((await requests.detail(U.A, a1.id)).settledAmount).toBe(600_000);

    const plan = await deletion.plan('FINANCIAL_REQUEST', settlement.id);
    const listed = plan.items.join('\n');
    expect(listed).toContain(`Tạm ứng ${a1.code}: bỏ đối trừ 600.000 đ`);
    expect(listed).toContain(`Tạm ứng ${a2.code}: bỏ đối trừ 400.000 đ`);
    expect(listed).toContain('1 lần chi tiền (200.000 đ)');

    await deletion.execute('FINANCIAL_REQUEST', settlement.id, U.K);
    for (const advance of [a1, a2]) {
      const d = await requests.detail(U.A, advance.id);
      expect(d.settledAmount).toBe(0);
      expect(d.settlementStatus).toBe(before);
    }
    expect(await countRows(`SELECT count(*) AS n FROM financial_requests WHERE id = $1`, [settlement.id])).toBe(0);
  });
});
