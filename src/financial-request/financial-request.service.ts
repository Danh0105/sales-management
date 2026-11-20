import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, In, Repository } from 'typeorm';

import { CashAccount } from '../cashflow-report/cash-account.entity';
import { Department } from '../department/department.entity';
import { Employee } from '../employee/employee.entity';
import { isEmployeeAdmin } from '../employee/employee-roles';
import {
  EMPLOYEE_POSITIONS,
  employeePosition,
} from '../employee/employee-positions';
import { Payroll } from '../payroll/entities/payroll.entity';
import { AuthUser } from '../type/auth-user.type';
import {
  AdjustItemsDto,
  ApproveStepDto,
  DecideStepDto,
  ItemAdjustmentDto,
  ReasonDto,
  UploadAttachmentDto,
  WithdrawDto,
} from './dto/financial-action.dto';
import {
  AdvanceAllocationDto,
  CreateFinancialRequestDto,
  FinancialRequestItemDto,
  FinancialRequestQueryDto,
  FinancialRequestSupplierDto,
  SalaryAdvanceCheckQueryDto,
  SavePayeeProfileDto,
  UpdateFinancialRequestDto,
} from './dto/financial-request.dto';
import { FinancialAdvanceAllocation } from './entities/financial-advance-allocation.entity';
import { FinancialApprovalStep } from './entities/financial-approval-step.entity';
import { FinancialApprovalWorkflow } from './entities/financial-approval-workflow.entity';
import { FinancialAuditLog } from './entities/financial-audit-log.entity';
import { FinancialCompany } from './entities/financial-company.entity';
import { FinancialEmployeeCompany } from './entities/financial-employee-company.entity';
import { FinancialExpenseCategory } from './entities/financial-expense-category.entity';
import { FinancialPayeeProfile } from './entities/financial-payee-profile.entity';
import { FinancialPayment } from './entities/financial-payment.entity';
import { FinancialPolicy } from './entities/financial-policy.entity';
import { FinancialRefund } from './entities/financial-refund.entity';
import { FinancialRequestAttachment } from './entities/financial-request-attachment.entity';
import { FinancialRequestItem } from './entities/financial-request-item.entity';
import { FinancialRequestSupplier } from './entities/financial-request-supplier.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialSalaryAdvanceDeduction } from './entities/financial-salary-advance-deduction.entity';
import { FinancialWorkflowStep } from './entities/financial-workflow-step.entity';
import { addDays, daysUntil, vnToday } from './financial-calculations';
import {
  FinanceContext,
  FinancialAccessService,
} from './financial-access.service';
import {
  FinancialLedgerService,
  payableDue,
  receivableDue,
} from './financial-ledger.service';
import { FinancialCashBalanceService } from './financial-cash-balance.service';
import { FinancialNotifyService, writeAudit } from './financial-notify.service';
import {
  ACTIVE_APPROVAL_STATUSES,
  ApprovalStatus,
  ATTACHMENT_MAX_FILES,
  AttachmentKind,
  AuditAction,
  DeductionRowStatus,
  DeductionStatus,
  DIRECT_MANAGER_SYSTEM_ROLES,
  FinanceRole,
  FinancialRequestType,
  PaymentStatus,
  RecoveryStatus,
  REQUEST_CODE_PREFIX,
  SelfApprovalMode,
  SettlementStatus,
  StepStatus,
} from './financial-request.constants';
import {
  formatVnd,
  lineAmount,
  requireText,
  sumMoney,
  vndToWords,
} from './financial-money';
import { openStoredFile, storeFile } from './financial-storage';
import { isControllerApprovalStep } from './financial-payment-account';
import {
  recipientTotals,
  sameAccount,
  supplierSubmitErrors,
} from './financial-suppliers';
import {
  nextStepsAfterDecision,
  pickWorkflow,
  planSteps,
  WorkflowPlanError,
} from './financial-workflow';

const EDITABLE = [ApprovalStatus.DRAFT, ApprovalStatus.RETURNED];

/** Trường header được dùng theo từng loại; trường khác bị xoá về NULL. */
const TYPE_FIELDS: Record<FinancialRequestType, string[]> = {
  [FinancialRequestType.ADVANCE]: ['expectedUseDate', 'settlementDueDate'],
  [FinancialRequestType.SALARY_ADVANCE]: [
    'salaryYear',
    'salaryMonth',
    'deductionStartYear',
    'deductionStartMonth',
    'deductionPeriods',
  ],
  [FinancialRequestType.SETTLEMENT]: [],
  [FinancialRequestType.EXPENSE_PAYMENT]: [
    'location',
    'tripStartDate',
    'tripEndDate',
  ],
  [FinancialRequestType.INTERNAL_TRANSFER]: [
    'transferFromAccountCode',
    'transferToAccountCode',
  ],
};
const TYPE_SPECIFIC = [...new Set(Object.values(TYPE_FIELDS).flat())];
const COMMON_FIELDS = [
  'requestDate',
  'title',
  'purpose',
  'projectName',
  'payeeName',
  'bankAccountHolder',
  'bankName',
  'bankAccountNumber',
  'paymentNote',
];

interface ComputedItem {
  id?: number;
  description: string;
  categoryId: number | null;
  categoryName: string | null;
  unit: string | null;
  quantity: string;
  unitPrice: string;
  amount: number;
  incurredDate: string | null;
  invoiceNumber: string | null;
  invoiceType: FinancialRequestItem['invoiceType'];
  supplierName: string | null;
  /** Vị trí NCC trong danh sách NCC của phiếu; NULL = trả cho người đề nghị. */
  supplierIndex: number | null;
  note: string | null;
  overLimit: boolean;
}

@Injectable()
export class FinancialRequestService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: FinancialAccessService,
    private readonly ledger: FinancialLedgerService,
    private readonly notifier: FinancialNotifyService,
    @InjectRepository(FinancialRequest)
    private readonly requestRepo: Repository<FinancialRequest>,
    @InjectRepository(FinancialRequestItem)
    private readonly itemRepo: Repository<FinancialRequestItem>,
    @InjectRepository(FinancialApprovalStep)
    private readonly stepRepo: Repository<FinancialApprovalStep>,
    @InjectRepository(FinancialRequestAttachment)
    private readonly attachmentRepo: Repository<FinancialRequestAttachment>,
    @InjectRepository(FinancialCompany)
    private readonly companyRepo: Repository<FinancialCompany>,
    @InjectRepository(FinancialExpenseCategory)
    private readonly categoryRepo: Repository<FinancialExpenseCategory>,
    @InjectRepository(FinancialPolicy)
    private readonly policyRepo: Repository<FinancialPolicy>,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    private readonly cashBalance?: FinancialCashBalanceService,
  ) {}

  /**
   * Số dư các tài khoản tiền theo Tổng hợp thu chi — form Điều chuyển tiền nội
   * bộ chọn nguồn + kiểm số tiền. Người lập phiếu điều chuyển hoặc người ghi
   * nhận chi/thu mới xem được.
   */
  async cashBalances(user: AuthUser) {
    const ctx = await this.access.context(user);
    if (
      !this.access.canCreateTransfer(ctx) &&
      !this.access.hasAnyRole(ctx, [FinanceRole.ACCOUNTANT, FinanceRole.CASHIER])
    ) {
      throw new ForbiddenException('Bạn không xem được số dư tài khoản tiền');
    }
    if (!this.cashBalance) throw new BadRequestException('Chưa cấu hình số dư');
    return this.cashBalance.balances();
  }

  // ===========================================================================
  // Danh mục cho form
  // ===========================================================================

  async meta(user: AuthUser) {
    const ctx = await this.access.context(user);
    const [companies, categories, departments, cashAccounts, me, payee, myCompany] =
      await Promise.all([
        this.companyRepo.find({
          where: { isActive: true },
          order: { name: 'ASC' },
        }),
        this.categoryRepo.find({
          where: { isActive: true },
          order: { sortOrder: 'ASC', name: 'ASC' },
        }),
        this.dataSource
          .getRepository(Department)
          .find({ order: { name: 'ASC' } }),
        this.dataSource.getRepository(CashAccount).find({
          where: { isActive: true },
          order: { groupCode: 'ASC', sortOrder: 'ASC' },
        }),
        this.employeeRepo.findOne({
          where: { id: ctx.userId },
          relations: ['department'],
        }),
        this.dataSource
          .getRepository(FinancialPayeeProfile)
          .findOne({ where: { employeeId: ctx.userId } }),
        this.dataSource
          .getRepository(FinancialEmployeeCompany)
          .findOne({ where: { employeeId: ctx.userId } }),
      ]);
    const moneyRoles = [FinanceRole.ACCOUNTANT, FinanceRole.CASHIER];
    return {
      companies: companies.map((c) => this.publicCompany(c)),
      categories: categories.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        limitAmount: c.limitAmount,
      })),
      departments: departments.map((d) => ({ id: d.id, name: d.name })),
      cashAccounts: cashAccounts.map((a) => ({
        code: a.code,
        name: a.name,
        groupCode: a.groupCode,
      })),
      me: {
        id: ctx.userId,
        name: me?.name ?? ctx.name,
        departmentId: me?.department?.id ?? null,
        departmentName: me?.department?.name ?? null,
        // Công ty được xếp ở màn Phân quyền — form đề nghị chọn sẵn (đổi được).
        companyId: companies.some((c) => c.id === myCompany?.companyId)
          ? (myCompany?.companyId ?? null)
          : null,
        position: this.positionOf(me),
        bankName: me?.bankName ?? null,
        bankAccountNumber: me?.bankAccountNumber ?? null,
        savedPayee: payee ? this.publicPayeeProfile(payee) : null,
      },
      capabilities: {
        isAdmin: ctx.isAdmin,
        canConfigure: this.access.canConfigure(ctx),
        canManageEmployees: isEmployeeAdmin(user),
        canViewAll:
          ctx.isAdmin ||
          this.access.hasAnyRole(ctx, [
            FinanceRole.CONTROLLER,
            FinanceRole.ACCOUNTANT,
            FinanceRole.CASHIER,
            FinanceRole.DIRECTOR,
            FinanceRole.VIEWER,
            FinanceRole.MANAGER,
          ]),
        canApprove:
          ctx.delegations.length > 0 ||
          ctx.systemRoles.some((r) =>
            DIRECT_MANAGER_SYSTEM_ROLES.includes(r),
          ) ||
          this.access.hasAnyRole(ctx, [
            FinanceRole.MANAGER,
            FinanceRole.CONTROLLER,
            FinanceRole.ACCOUNTANT,
            FinanceRole.DIRECTOR,
          ]),
        canManagePayments:
          ctx.isAdmin || this.access.hasAnyRole(ctx, moneyRoles),
        canCreateTransfer: this.access.canCreateTransfer(ctx),
        canViewReports:
          ctx.isAdmin ||
          this.access.hasAnyRole(ctx, [
            FinanceRole.ACCOUNTANT,
            FinanceRole.DIRECTOR,
            FinanceRole.VIEWER,
            FinanceRole.CONTROLLER,
          ]),
        canConfirmDeductions:
          ctx.isAdmin ||
          this.access.hasAnyRole(ctx, [FinanceRole.ACCOUNTANT]) ||
          ctx.systemRoles.some((r) => ['nhansu', 'ketoan_truong'].includes(r)),
        roles: [...new Set(ctx.scopes.map((s) => s.role))],
      },
    };
  }

  async eligibleManagers(user: AuthUser, companyId: number) {
    const ctx = await this.access.context(user);
    const me = await this.employeeRepo.findOne({
      where: { id: ctx.userId },
      relations: ['department'],
    });
    const departmentId = me?.department?.id ?? null;
    const [managers, departmentManagerIds] = await Promise.all([
      this.access.eligibleManagers(companyId, departmentId),
      this.access.departmentManagerIds(companyId, departmentId),
    ]);
    const choices = managers.filter((m) => m.id !== ctx.userId);
    // Quản lý của phòng ban người đề nghị — form chọn sẵn, người lập vẫn đổi được.
    const defaultId =
      departmentManagerIds.find((id) => choices.some((m) => m.id === id)) ??
      null;
    return choices.map((m) => ({
      id: m.id,
      name: m.name,
      position: this.positionOf(m),
      isDefault: m.id === defaultId,
    }));
  }

  /** Lưu (ghi đè) thông tin nhận tiền của chính người dùng, không sửa hồ sơ nhân viên. */
  async savePayeeProfile(user: AuthUser, dto: SavePayeeProfileDto) {
    const ctx = await this.access.context(user);
    const repo = this.dataSource.getRepository(FinancialPayeeProfile);
    const clean = (value?: string | null) => value?.trim() || null;
    await repo.upsert(
      {
        employeeId: ctx.userId,
        payeeName: clean(dto.payeeName),
        bankAccountHolder: clean(dto.bankAccountHolder),
        bankName: clean(dto.bankName),
        bankAccountNumber: clean(dto.bankAccountNumber),
        updatedAt: new Date(),
      },
      ['employeeId'],
    );
    return this.publicPayeeProfile(
      await repo.findOneByOrFail({ employeeId: ctx.userId }),
    );
  }

  private publicPayeeProfile(p: FinancialPayeeProfile) {
    return {
      payeeName: p.payeeName,
      bankAccountHolder: p.bankAccountHolder,
      bankName: p.bankName,
      bankAccountNumber: p.bankAccountNumber,
      updatedAt: p.updatedAt,
    };
  }

  private publicCompany(c: FinancialCompany) {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      shortName: c.shortName,
      taxCode: c.taxCode,
      address: c.address,
      hasLogo: !!c.logoPath,
      formCodes: c.formCodes ?? {},
    };
  }

  private positionOf(employee?: Employee | null): string | null {
    const roles = employee?.roles ?? [];
    // Giám đốc, trưởng/phó phòng ghi trước role nghiệp vụ kiêm cùng (vd. Sale Admin kiêm trưởng phòng).
    const role =
      DIRECT_MANAGER_SYSTEM_ROLES.find((r) => roles.includes(r)) ??
      EMPLOYEE_POSITIONS.find((p) => roles.includes(p.value))?.value;
    return employeePosition(role)?.label ?? null;
  }

  // ===========================================================================
  // Danh sách
  // ===========================================================================

  async list(user: AuthUser, query: FinancialRequestQueryDto) {
    const ctx = await this.access.context(user);
    const qb = this.buildListQuery(ctx, query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const totalsQb = qb.clone();
    // Dùng tên thuộc tính (không phải tên cột): skip/take + join của TypeORM cần vậy.
    const sortColumn =
      {
        requestDate: 'r.requestDate',
        createdAt: 'r.createdAt',
        totalAmount: 'r.totalAmount',
        code: 'r.code',
      }[query.sort ?? 'createdAt'] ?? 'r.createdAt';
    const order =
      (query.order ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    qb.leftJoinAndSelect('r.company', 'company')
      .orderBy(sortColumn, order)
      .addOrderBy('r.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    const totals = await totalsQb
      .select('COALESCE(SUM(r.total_amount), 0)', 'totalAmount')
      .addSelect('COALESCE(SUM(r.approved_amount), 0)', 'approvedAmount')
      .addSelect('COALESCE(SUM(r.paid_amount), 0)', 'paidAmount')
      .addSelect('COALESCE(SUM(r.recovered_amount), 0)', 'recoveredAmount')
      .getRawOne<Record<string, string>>();

    const pending = rows.length
      ? await this.stepRepo
          .createQueryBuilder('s')
          .innerJoin(
            FinancialRequest,
            'r',
            'r.id = s.request_id AND r.current_round = s.round',
          )
          .where('s.request_id IN (:...ids)', { ids: rows.map((r) => r.id) })
          .andWhere('s.status = :pending', { pending: StepStatus.PENDING })
          .orderBy('s.step_order', 'ASC')
          .getMany()
      : [];

    const today = vnToday();
    return {
      data: rows.map((r) => {
        const step = pending.find((s) => s.requestId === r.id);
        const canAct = step
          ? pending
              .filter((s) => s.requestId === r.id)
              .some((s) => this.access.eligibility(ctx, r, s).eligible)
          : false;
        return {
          id: r.id,
          code: r.code,
          type: r.type,
          title: r.title,
          companyId: r.companyId,
          companyName: r.company?.shortName || r.company?.name || null,
          requesterId: r.requesterId,
          requesterName: r.requesterName,
          departmentName: r.departmentName,
          requestDate: r.requestDate,
          totalAmount: r.totalAmount,
          approvedAmount: r.approvedAmount,
          offsetAmount: r.offsetAmount,
          paidAmount: r.paidAmount,
          recoveredAmount: r.recoveredAmount,
          payableRemaining: Math.max(payableDue(r) - r.paidAmount, 0),
          receivableRemaining: Math.max(
            receivableDue(r) - r.recoveredAmount,
            0,
          ),
          approvalStatus: r.approvalStatus,
          paymentStatus: r.paymentStatus,
          recoveryStatus: r.recoveryStatus,
          settlementStatus: r.settlementStatus,
          deductionStatus: r.deductionStatus,
          settlementDueDate: r.settlementDueDate,
          overdue: this.isOverdue(r, today),
          currentStepName: step?.name ?? null,
          canAct,
          isOwner: r.requesterId === ctx.userId,
          createdAt: r.createdAt,
        };
      }),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      totals: {
        totalAmount: Number(totals?.totalAmount ?? 0),
        approvedAmount: Number(totals?.approvedAmount ?? 0),
        paidAmount: Number(totals?.paidAmount ?? 0),
        recoveredAmount: Number(totals?.recoveredAmount ?? 0),
      },
    };
  }

  /** Truy vấn danh sách đã gắn phạm vi quyền + bộ lọc — dùng chung cho xuất Excel. */
  buildListQuery(ctx: FinanceContext, query: FinancialRequestQueryDto) {
    const qb = this.requestRepo.createQueryBuilder('r');
    const scope = query.scope ?? 'mine';
    if (scope === 'mine') {
      qb.where('r.deleted_at IS NULL').andWhere(
        '(r.requester_id = :uid OR r.created_by_id = :uid)',
        { uid: ctx.userId },
      );
    } else if (scope === 'approvals') {
      qb.where('r.deleted_at IS NULL');
      this.access.applyPendingForMe(qb, ctx);
    } else {
      this.access.applyVisibility(qb, ctx);
      if (scope === 'payments') {
        if (
          !ctx.isAdmin &&
          !this.access.hasAnyRole(ctx, [
            FinanceRole.ACCOUNTANT,
            FinanceRole.CASHIER,
          ])
        ) {
          throw new ForbiddenException('Bạn không có quyền quản lý thanh toán');
        }
        qb.andWhere('r.approval_status = :approved', {
          approved: ApprovalStatus.APPROVED,
        }).andWhere(
          new Brackets((w) =>
            w
              .where('r.payment_status IN (:...unpaid)', {
                unpaid: [PaymentStatus.UNPAID, PaymentStatus.PARTIALLY_PAID],
              })
              .orWhere('r.recovery_status IN (:...open)', {
                open: [RecoveryStatus.PENDING, RecoveryStatus.PARTIAL],
              }),
          ),
        );
      }
    }
    if (scope !== 'mine' && scope !== 'approvals') {
      // Bản nháp chỉ chủ phiếu thấy.
      qb.andWhere(
        new Brackets((w) =>
          w
            .where('r.approval_status <> :draft', {
              draft: ApprovalStatus.DRAFT,
            })
            .orWhere('r.requester_id = :draftUid', { draftUid: ctx.userId }),
        ),
      );
    }

    const list = (value?: string) =>
      value
        ?.split(',')
        .map((v) => v.trim())
        .filter(Boolean) ?? [];
    if (query.type) qb.andWhere('r.type = :type', { type: query.type });
    if (query.companyId)
      qb.andWhere('r.company_id = :companyId', { companyId: query.companyId });
    if (query.departmentId)
      qb.andWhere('r.department_id = :departmentId', {
        departmentId: query.departmentId,
      });
    if (query.requesterId)
      qb.andWhere('r.requester_id = :requesterId', {
        requesterId: query.requesterId,
      });
    if (list(query.approvalStatus).length)
      qb.andWhere('r.approval_status IN (:...approvalStatuses)', {
        approvalStatuses: list(query.approvalStatus),
      });
    if (list(query.paymentStatus).length)
      qb.andWhere('r.payment_status IN (:...paymentStatuses)', {
        paymentStatuses: list(query.paymentStatus),
      });
    if (list(query.settlementStatus).length)
      qb.andWhere('r.settlement_status IN (:...settlementStatuses)', {
        settlementStatuses: list(query.settlementStatus),
      });
    if (query.dateFrom)
      qb.andWhere('r.request_date >= :dateFrom', { dateFrom: query.dateFrom });
    if (query.dateTo)
      qb.andWhere('r.request_date <= :dateTo', { dateTo: query.dateTo });
    if (query.amountMin !== undefined)
      qb.andWhere('r.total_amount >= :amountMin', {
        amountMin: query.amountMin,
      });
    if (query.amountMax !== undefined)
      qb.andWhere('r.total_amount <= :amountMax', {
        amountMax: query.amountMax,
      });
    if (query.code)
      qb.andWhere('r.code ILIKE :code', { code: `%${query.code}%` });
    if (query.q) {
      qb.andWhere(
        '(r.code ILIKE :q OR r.title ILIKE :q OR r.requester_name ILIKE :q OR r.project_name ILIKE :q)',
        { q: `%${query.q}%` },
      );
    }
    if (query.overdue === 'true') {
      qb.andWhere('r.type = :advType', {
        advType: FinancialRequestType.ADVANCE,
      })
        .andWhere('r.approval_status = :advApproved', {
          advApproved: ApprovalStatus.APPROVED,
        })
        .andWhere('r.paid_amount > r.settled_amount')
        .andWhere('r.settlement_due_date < :today', { today: vnToday() });
    }
    return qb;
  }

  private isOverdue(r: FinancialRequest, today = vnToday()) {
    return (
      r.type === FinancialRequestType.ADVANCE &&
      r.approvalStatus === ApprovalStatus.APPROVED &&
      r.paidAmount > r.settledAmount &&
      !!r.settlementDueDate &&
      r.settlementDueDate < today
    );
  }

  // ===========================================================================
  // Chi tiết
  // ===========================================================================

  async detail(user: AuthUser, id: number) {
    const ctx = await this.access.context(user);
    const request = await this.requestRepo.findOne({
      where: { id },
      relations: ['company'],
    });
    if (!request || request.deletedAt)
      throw new NotFoundException('Không tìm thấy chứng từ');
    const steps = await this.stepRepo.find({
      where: { requestId: id },
      order: { round: 'ASC', stepOrder: 'ASC' },
    });
    this.assertCanSee(ctx, request, steps);
    return this.toDetail(ctx, request, steps);
  }

  /**
   * Quy tắc xem dùng chung cho chi tiết, tệp đính kèm, PDF và sao chép: phạm
   * vi quyền + bản nháp chỉ người lập (và quản trị) thấy.
   */
  private assertCanSee(
    ctx: FinanceContext,
    request: FinancialRequest,
    steps: FinancialApprovalStep[],
  ) {
    this.access.assertView(ctx, request, steps);
    if (
      request.approvalStatus === ApprovalStatus.DRAFT &&
      request.requesterId !== ctx.userId &&
      request.createdById !== ctx.userId &&
      !ctx.isAdmin
    ) {
      throw new ForbiddenException('Bản nháp chỉ người lập xem được');
    }
  }

  private async toDetail(
    ctx: FinanceContext,
    request: FinancialRequest,
    steps: FinancialApprovalStep[],
  ) {
    const manager = this.dataSource.manager;
    const [
      items,
      attachments,
      payments,
      refunds,
      deductions,
      audit,
      workflow,
      paymentAccount,
      suppliers,
    ] = await Promise.all([
      this.itemRepo.find({
        where: { requestId: request.id },
        order: { lineNo: 'ASC' },
      }),
      this.attachmentRepo.find({
        where: { requestId: request.id },
        order: { createdAt: 'ASC' },
      }),
      manager.getRepository(FinancialPayment).find({
        where: { requestId: request.id },
        order: { createdAt: 'ASC' },
      }),
      manager.getRepository(FinancialRefund).find({
        where: { requestId: request.id },
        order: { createdAt: 'ASC' },
      }),
      manager.getRepository(FinancialSalaryAdvanceDeduction).find({
        where: { requestId: request.id },
        order: { periodYear: 'ASC', periodMonth: 'ASC' },
      }),
      manager.getRepository(FinancialAuditLog).find({
        where: { requestId: request.id },
        order: { createdAt: 'DESC', id: 'DESC' },
      }),
      request.workflowId
        ? manager
            .getRepository(FinancialApprovalWorkflow)
            .findOne({ where: { id: request.workflowId } })
        : Promise.resolve(null),
      request.paymentAccountCode
        ? manager
            .getRepository(CashAccount)
            .findOne({ where: { code: request.paymentAccountCode } })
        : Promise.resolve(null),
      this.loadSuppliers(manager, request.id),
    ]);

    const allocations =
      request.type === FinancialRequestType.SETTLEMENT
        ? await this.ledger.allocationsOfSettlement(request)
        : [];
    const settlements =
      request.type === FinancialRequestType.ADVANCE
        ? await this.ledger.settlementsOfAdvance(request.id)
        : [];

    const candidateIds = [
      ...new Set(
        steps
          .filter((s) => s.status === StepStatus.PENDING)
          .flatMap((s) => s.candidateApproverIds ?? []),
      ),
    ];
    const candidateNames = candidateIds.length
      ? new Map(
          (
            await this.employeeRepo.find({
              where: { id: In(candidateIds) },
              select: ['id', 'name'],
            })
          ).map((e) => [e.id as number, e.name ?? `#${e.id}`]),
        )
      : new Map<number, string>();

    const isOwner =
      request.requesterId === ctx.userId || request.createdById === ctx.userId;
    const currentPending = steps.filter(
      (s) =>
        s.round === request.currentRound && s.status === StepStatus.PENDING,
    );
    const actionable = currentPending.find(
      (s) => this.access.eligibility(ctx, request, s).eligible,
    );
    const payable = payableDue(request);
    const receivable = receivableDue(request);
    const payableRemaining = Math.max(payable - request.paidAmount, 0);
    const receivableRemaining = Math.max(
      receivable - request.recoveredAmount,
      0,
    );
    const canRecordMoney = this.access.canRecordMoney(ctx, request);
    const canSeeBank = this.access.canSeeBank(ctx, request);
    const canSeeSalary = this.access.canSeeSalary(ctx, request);
    const hasMovements = await this.ledger.hasMoneyMovements(manager, request);
    const today = vnToday();
    const approvedTotal = sumMoney(
      items.map((i) => i.approvedAmount ?? i.amount),
    );

    const maskBank = (value: string | null) =>
      canSeeBank ? value : FinancialAccessService.maskAccount(value);
    const supplierById = new Map(suppliers.map((sp) => [sp.id, sp]));
    // Người nhận tiền: người đề nghị (nếu còn dòng của họ hoặc phiếu không có
    // NCC) + từng NCC; số tiền = tổng các dòng gán cho họ.
    const recipients = recipientTotals(suppliers, items, payments)
      .filter((r) => r.supplierId !== null || r.amount > 0 || !suppliers.length)
      .map((r) => {
        const supplier =
          r.supplierId !== null ? supplierById.get(r.supplierId) : undefined;
        return {
          supplierId: r.supplierId,
          kind: supplier ? ('SUPPLIER' as const) : ('REQUESTER' as const),
          name: supplier
            ? supplier.name
            : request.payeeName || request.requesterName,
          bankAccountHolder: supplier
            ? supplier.bankAccountHolder
            : request.bankAccountHolder,
          bankName: supplier ? supplier.bankName : request.bankName,
          bankAccountNumber: maskBank(
            supplier ? supplier.bankAccountNumber : request.bankAccountNumber,
          ),
          amount: r.amount,
          paidAmount: r.paidAmount,
          // Chỉ phiếu đã duyệt mới có nghĩa vụ chi.
          remaining:
            request.approvalStatus === ApprovalStatus.APPROVED ? r.remaining : 0,
        };
      });

    const warnings = await this.collectWarnings(
      ctx,
      request,
      items,
      canSeeBank,
      suppliers,
    );

    return {
      id: request.id,
      code: request.code,
      type: request.type,
      company: request.company ? this.publicCompany(request.company) : null,
      companyId: request.companyId,
      requesterId: request.requesterId,
      requesterName: request.requesterName,
      requesterCode: request.requesterCode,
      requesterPosition: request.requesterPosition,
      departmentId: request.departmentId,
      departmentName: request.departmentName,
      directManagerId: request.directManagerId,
      directManagerName: request.directManagerName,
      requestDate: request.requestDate,
      title: request.title,
      purpose: request.purpose,
      projectName: request.projectName,
      expectedUseDate: request.expectedUseDate,
      settlementDueDate: request.settlementDueDate,
      location: request.location,
      tripStartDate: request.tripStartDate,
      tripEndDate: request.tripEndDate,
      salaryYear: request.salaryYear,
      salaryMonth: request.salaryMonth,
      expectedSalary: canSeeSalary ? request.expectedSalary : null,
      deductionStartYear: request.deductionStartYear,
      deductionStartMonth: request.deductionStartMonth,
      deductionPeriods: request.deductionPeriods,
      payeeName: request.payeeName,
      bankAccountHolder: request.bankAccountHolder,
      bankName: request.bankName,
      bankAccountNumber: canSeeBank
        ? request.bankAccountNumber
        : FinancialAccessService.maskAccount(request.bankAccountNumber),
      paymentMethod: request.paymentMethod,
      paymentAccountCode: request.paymentAccountCode,
      paymentAccountName: paymentAccount?.name ?? null,
      paymentNote: request.paymentNote,
      transferFromAccountCode: request.transferFromAccountCode,
      transferToAccountCode: request.transferToAccountCode,
      suppliers: suppliers.map((sp) => ({
        id: sp.id,
        lineNo: sp.lineNo,
        name: sp.name,
        bankAccountHolder: sp.bankAccountHolder,
        bankName: sp.bankName,
        bankAccountNumber: maskBank(sp.bankAccountNumber),
        note: sp.note,
      })),
      recipients,
      currency: request.currency,
      totalAmount: request.totalAmount,
      approvedAmount: request.approvedAmount,
      offsetAmount: request.offsetAmount,
      paidAmount: request.paidAmount,
      recoveredAmount: request.recoveredAmount,
      settledAmount: request.settledAmount,
      deductedAmount: request.deductedAmount,
      approvalStatus: request.approvalStatus,
      paymentStatus: request.paymentStatus,
      recoveryStatus: request.recoveryStatus,
      settlementStatus: request.settlementStatus,
      deductionStatus: request.deductionStatus,
      workflowName: request.workflowName,
      isSequential: request.isSequential,
      currentRound: request.currentRound,
      submittedAt: request.submittedAt,
      approvedAt: request.approvedAt,
      rejectedAt: request.rejectedAt,
      completedAt: request.completedAt,
      cancelledAt: request.cancelledAt,
      cancelReason: request.cancelReason,
      copiedFromId: request.copiedFromId,
      version: request.version,
      createdById: request.createdById,
      createdByName: request.createdByName,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      summary: {
        totalAmount: request.totalAmount,
        approvedTotal:
          request.approvalStatus === ApprovalStatus.APPROVED
            ? (request.approvedAmount ?? approvedTotal)
            : approvedTotal,
        offsetAmount: request.offsetAmount,
        difference:
          request.type === FinancialRequestType.SETTLEMENT
            ? approvedTotal -
              (request.offsetAmount ||
                sumMoney(allocations.map((a) => a.amount)))
            : null,
        payableDue: payable,
        payableRemaining,
        receivableDue: receivable,
        receivableRemaining,
        advanceOutstanding:
          request.type === FinancialRequestType.ADVANCE
            ? Math.max(request.paidAmount - request.settledAmount, 0)
            : null,
        salaryOutstanding:
          request.type === FinancialRequestType.SALARY_ADVANCE
            ? Math.max(request.paidAmount - request.deductedAmount, 0)
            : null,
        amountInWords: vndToWords(request.totalAmount),
        approvedInWords: vndToWords(approvedTotal),
        overdue: this.isOverdue(request, today),
        daysToDue: request.settlementDueDate
          ? daysUntil(request.settlementDueDate, today)
          : null,
      },
      items: items.map((item) => ({
        id: item.id,
        lineNo: item.lineNo,
        description: item.description,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        approvedAmount: item.approvedAmount,
        adjustmentReason: item.adjustmentReason,
        adjustedByName: item.adjustedByName,
        adjustedAt: item.adjustedAt,
        incurredDate: item.incurredDate,
        invoiceNumber: item.invoiceNumber,
        invoiceType: item.invoiceType,
        supplierName: item.supplierName,
        supplierId:
          item.supplierId !== null && supplierById.has(item.supplierId)
            ? item.supplierId
            : null,
        note: item.note,
        overLimit: item.overLimit,
        attachmentCount: attachments.filter(
          (a) => a.itemId === item.id && !a.deletedAt,
        ).length,
      })),
      attachments: attachments
        .filter((a) => !a.deletedAt)
        .map((a) => ({
          id: a.id,
          kind: a.kind,
          itemId: a.itemId,
          paymentId: a.paymentId,
          refundId: a.refundId,
          originalName: a.originalName,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          uploadedById: a.uploadedById,
          uploadedByName: a.uploadedByName,
          createdAt: a.createdAt,
          canDelete: this.canDeleteAttachment(ctx, request, a),
        })),
      steps: steps.map((s) => ({
        id: s.id,
        round: s.round,
        stepOrder: s.stepOrder,
        name: s.name,
        signatureSlot: s.signatureSlot,
        approverType: s.approverType,
        approverRole: s.approverRole,
        status: s.status,
        canAdjustAmounts: s.canAdjustAmounts,
        skippable: s.skippable,
        candidates:
          s.status === StepStatus.PENDING
            ? (s.candidateApproverIds ?? []).map((cid) => ({
                id: cid,
                name: candidateNames.get(cid) ?? `#${cid}`,
              }))
            : [],
        actedById: s.actedById,
        actedByName: s.actedByName,
        onBehalfOfName: s.onBehalfOfName,
        actedAt: s.actedAt,
        comment: s.comment,
        activatedAt: s.activatedAt,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        amount: p.amount,
        supplierId: p.supplierId,
        recipientName:
          (p.supplierId !== null
            ? supplierById.get(p.supplierId)?.name
            : undefined) ??
          (request.payeeName || request.requesterName),
        date: p.paidAt,
        method: p.method,
        cashAccountCode: p.cashAccountCode,
        transactionRef: p.transactionRef,
        note: p.note,
        status: p.status,
        recordedByName: p.recordedByName,
        createdAt: p.createdAt,
        voidedAt: p.voidedAt,
        voidedByName: p.voidedByName,
        voidReason: p.voidReason,
      })),
      refunds: refunds.map((p) => ({
        id: p.id,
        amount: p.amount,
        date: p.receivedAt,
        method: p.method,
        cashAccountCode: p.cashAccountCode,
        transactionRef: p.transactionRef,
        note: p.note,
        status: p.status,
        recordedByName: p.recordedByName,
        createdAt: p.createdAt,
        voidedAt: p.voidedAt,
        voidedByName: p.voidedByName,
        voidReason: p.voidReason,
      })),
      allocations,
      settlements,
      deductions: deductions.map((d) => ({
        id: d.id,
        periodYear: d.periodYear,
        periodMonth: d.periodMonth,
        plannedAmount: d.plannedAmount,
        deductedAmount: d.deductedAmount,
        status: d.status,
        payrollId: d.payrollId,
        deductedAt: d.deductedAt,
        deductedByName: d.deductedByName,
        note: d.note,
      })),
      audit: audit.map((log) => ({
        id: log.id,
        action: log.action,
        fromStatus: log.fromStatus,
        toStatus: log.toStatus,
        actorName: log.actorName,
        comment: log.comment,
        changes: log.changes,
        createdAt: log.createdAt,
      })),
      warnings,
      permissions: {
        isOwner,
        canEdit: isOwner && EDITABLE.includes(request.approvalStatus),
        canSubmit: isOwner && EDITABLE.includes(request.approvalStatus),
        canDelete: isOwner && request.approvalStatus === ApprovalStatus.DRAFT,
        canWithdraw:
          isOwner &&
          request.approvalStatus === ApprovalStatus.PENDING &&
          (workflow?.allowWithdraw ?? true),
        actionableStepId: actionable?.id ?? null,
        canApprove: !!actionable,
        canAdjust: !!actionable?.canAdjustAmounts,
        isControlStep: !!actionable && isControllerApprovalStep(actionable),
        canSkip: ctx.isAdmin && currentPending.some((s) => s.skippable),
        canRecordPayment:
          request.approvalStatus === ApprovalStatus.APPROVED &&
          payableRemaining > 0 &&
          canRecordMoney,
        canRecordRefund:
          request.approvalStatus === ApprovalStatus.APPROVED &&
          receivableRemaining > 0 &&
          canRecordMoney,
        canVoidMoney: this.access.canVoidMoney(ctx, request),
        canConfirmDeduction:
          request.type === FinancialRequestType.SALARY_ADVANCE &&
          this.access.canConfirmDeduction(ctx, request),
        canCancel:
          request.approvalStatus === ApprovalStatus.APPROVED &&
          !hasMovements &&
          (ctx.isAdmin ||
            this.access.hasRole(
              ctx,
              FinanceRole.ACCOUNTANT,
              request.companyId,
              request.departmentId,
            )),
        canUploadDocuments:
          isOwner && EDITABLE.includes(request.approvalStatus),
        canUploadPaymentProof:
          request.approvalStatus === ApprovalStatus.APPROVED && canRecordMoney,
        canSeeBank,
        canCreateSettlement:
          isOwner &&
          request.type === FinancialRequestType.ADVANCE &&
          request.paidAmount > request.settledAmount,
      },
    };
  }

  private async collectWarnings(
    ctx: FinanceContext,
    request: FinancialRequest,
    items: FinancialRequestItem[],
    canSeeBank: boolean,
    suppliers: FinancialRequestSupplier[] = [],
  ): Promise<string[]> {
    const warnings: string[] = [];
    if (canSeeBank && suppliers.length) {
      const requester = await this.employeeRepo.findOne({
        where: { id: request.requesterId },
        select: ['id', 'bankAccountNumber'],
      });
      for (const supplier of suppliers) {
        if (
          sameAccount(supplier.bankAccountNumber, requester?.bankAccountNumber) ||
          sameAccount(supplier.bankAccountNumber, request.bankAccountNumber)
        ) {
          warnings.push(
            `Tài khoản của NCC "${supplier.name}" trùng tài khoản cá nhân của người đề nghị — kiểm tra trước khi chi.`,
          );
        }
      }
    }
    for (const item of items.filter((i) => i.overLimit)) {
      warnings.push(
        `Dòng ${item.lineNo} (${item.description}) vượt định mức danh mục "${item.categoryName}".`,
      );
    }
    if (canSeeBank && request.bankAccountNumber) {
      const requester = await this.employeeRepo.findOne({
        where: { id: request.requesterId },
        select: ['id', 'bankAccountNumber'],
      });
      const norm = (v?: string | null) => (v ?? '').replace(/\s+/g, '');
      if (
        requester?.bankAccountNumber &&
        norm(requester.bankAccountNumber) !== norm(request.bankAccountNumber)
      ) {
        warnings.push(
          'Tài khoản nhận tiền khác tài khoản lưu trong hồ sơ nhân viên — kiểm tra trước khi chi.',
        );
      }
    }
    const invoices = items.filter((i) => i.invoiceNumber);
    if (invoices.length) {
      const duplicates = await this.itemRepo
        .createQueryBuilder('i')
        .innerJoin(FinancialRequest, 'r', 'r.id = i.request_id')
        .select(['i.invoice_number AS "invoiceNumber"', 'r.code AS "code"'])
        .where('i.request_id <> :id', { id: request.id })
        .andWhere('r.deleted_at IS NULL')
        .andWhere('r.approval_status IN (:...active)', {
          active: ACTIVE_APPROVAL_STATUSES,
        })
        .andWhere('LOWER(i.invoice_number) IN (:...numbers)', {
          numbers: invoices.map((i) =>
            (i.invoiceNumber as string).toLowerCase(),
          ),
        })
        .getRawMany<{ invoiceNumber: string; code: string }>();
      for (const dup of duplicates) {
        warnings.push(
          `Hoá đơn số ${dup.invoiceNumber} đã được kê khai ở phiếu ${dup.code}.`,
        );
      }
    }
    if (
      request.type === FinancialRequestType.EXPENSE_PAYMENT &&
      request.requesterId === ctx.userId &&
      EDITABLE.includes(request.approvalStatus)
    ) {
      const open = await this.ledger.myOpenAdvances(
        ctx.userId,
        request.companyId,
      );
      if (open.count) {
        warnings.push(
          `Bạn còn ${open.count} khoản tạm ứng chưa hoàn ứng (${formatVnd(open.outstanding)} đ). Nếu chi phí này dùng tiền tạm ứng, hãy lập Giấy đề nghị hoàn ứng để không thanh toán trùng.`,
        );
      }
    }
    return warnings;
  }

  // ===========================================================================
  // Tạo / sửa bản nháp
  // ===========================================================================

  private async requesterSnapshot(manager: EntityManager, userId: number) {
    const employee = await manager.getRepository(Employee).findOne({
      where: { id: userId },
      relations: ['department'],
    });
    if (!employee)
      throw new ForbiddenException('Không tìm thấy hồ sơ nhân viên');
    return employee;
  }

  private async assertCompany(manager: EntityManager, companyId: number) {
    const company = await manager
      .getRepository(FinancialCompany)
      .findOne({ where: { id: companyId } });
    if (!company || !company.isActive) {
      throw new BadRequestException(
        'Công ty không hợp lệ hoặc đã ngừng sử dụng',
      );
    }
    return company;
  }

  /** Gán các trường header được phép theo loại chứng từ. */
  /** Lỗi nguồn chuyển / nguồn nhận của phiếu Điều chuyển tiền nội bộ. */
  private async transferAccountErrors(
    manager: EntityManager,
    request: FinancialRequest,
  ): Promise<string[]> {
    const errors: string[] = [];
    const from = request.transferFromAccountCode;
    const to = request.transferToAccountCode;
    if (!from) errors.push('Chọn nguồn chuyển');
    if (!to) errors.push('Chọn nguồn nhận');
    if (from && to && from === to) {
      errors.push('Nguồn chuyển và nguồn nhận phải khác nhau');
    }
    const codes = [from, to].filter((code): code is string => !!code);
    if (codes.length) {
      const found = await manager
        .getRepository(CashAccount)
        .find({ where: { code: In(codes) } });
      for (const code of codes) {
        const account = found.find((a) => a.code === code);
        if (!account || !account.isActive) {
          errors.push(`Tài khoản tiền "${code}" không hợp lệ hoặc đã ngừng dùng`);
        }
      }
    }
    return [...new Set(errors)];
  }

  /**
   * Kiểm nguồn của phiếu điều chuyển khi lưu: tài khoản phải có thật, hai nguồn
   * khác nhau. `required` = bắt buộc đủ cả hai (lúc gửi duyệt); bản nháp được
   * để trống.
   */
  private async assertTransferAccounts(
    manager: EntityManager,
    request: FinancialRequest,
    required: boolean,
  ) {
    const errors = (await this.transferAccountErrors(manager, request)).filter(
      (error) => required || !error.startsWith('Chọn nguồn'),
    );
    if (errors.length) throw new BadRequestException(errors.join('; '));
  }

  private applyHeader(
    request: FinancialRequest,
    dto: Partial<CreateFinancialRequestDto>,
  ) {
    const allowed = new Set([...COMMON_FIELDS, ...TYPE_FIELDS[request.type]]);
    for (const field of [...COMMON_FIELDS, ...TYPE_SPECIFIC]) {
      const value = (dto as Record<string, unknown>)[field];
      if (value === undefined) continue;
      if (!allowed.has(field)) continue;
      (request as unknown as Record<string, unknown>)[field] = value;
    }
    for (const field of TYPE_SPECIFIC) {
      if (!allowed.has(field)) {
        (request as unknown as Record<string, unknown>)[field] = null;
      }
    }
    if (request.type !== FinancialRequestType.SALARY_ADVANCE) {
      request.expectedSalary = null;
    }
  }

  private async computeItems(
    manager: EntityManager,
    request: FinancialRequest,
    dtoItems: FinancialRequestItemDto[] | undefined,
    requestedAmount: number | undefined,
  ): Promise<ComputedItem[] | undefined> {
    if (request.type === FinancialRequestType.INTERNAL_TRANSFER) {
      if (requestedAmount === undefined) return undefined;
      const from = request.transferFromAccountCode ?? '?';
      const to = request.transferToAccountCode ?? '?';
      return [
        {
          description: `Điều chuyển tiền nội bộ từ ${from} sang ${to}`,
          categoryId: null,
          categoryName: null,
          unit: null,
          quantity: '1',
          unitPrice: String(requestedAmount),
          amount: lineAmount('1', String(requestedAmount)),
          incurredDate: null,
          invoiceNumber: null,
          invoiceType: null,
          supplierName: null,
          supplierIndex: null,
          note: null,
          overLimit: false,
        },
      ];
    }
    if (request.type === FinancialRequestType.SALARY_ADVANCE) {
      if (requestedAmount === undefined) return undefined;
      const period =
        request.salaryMonth && request.salaryYear
          ? ` tháng ${String(request.salaryMonth).padStart(2, '0')}/${request.salaryYear}`
          : '';
      return [
        {
          description: `Tạm ứng lương${period}`,
          categoryId: null,
          categoryName: null,
          unit: null,
          quantity: '1',
          unitPrice: String(requestedAmount),
          amount: lineAmount('1', String(requestedAmount)),
          incurredDate: null,
          invoiceNumber: null,
          invoiceType: null,
          supplierName: null,
          supplierIndex: null,
          note: null,
          overLimit: false,
        },
      ];
    }
    if (dtoItems === undefined) return undefined;
    const categoryIds = [
      ...new Set(
        dtoItems.map((i) => i.categoryId).filter((id): id is number => !!id),
      ),
    ];
    const categories = categoryIds.length
      ? await manager
          .getRepository(FinancialExpenseCategory)
          .find({ where: { id: In(categoryIds) } })
      : [];
    return dtoItems.map((item, index) => {
      const category = item.categoryId
        ? categories.find((c) => c.id === item.categoryId)
        : undefined;
      if (item.categoryId && !category) {
        throw new BadRequestException(
          `Dòng ${index + 1}: danh mục chi phí không tồn tại`,
        );
      }
      const amount = lineAmount(item.quantity, item.unitPrice);
      const supplierIndex = item.supplierIndex ?? null;
      if (
        supplierIndex !== null &&
        request.type !== FinancialRequestType.EXPENSE_PAYMENT
      ) {
        throw new BadRequestException(
          'Chỉ phiếu Thanh toán chi phí được chuyển tiền cho nhà cung cấp',
        );
      }
      return {
        id: item.id,
        description: item.description.trim(),
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        unit: item.unit ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount,
        incurredDate: item.incurredDate ?? null,
        invoiceNumber: item.invoiceNumber?.trim() || null,
        invoiceType: item.invoiceType ?? null,
        supplierName: item.supplierName ?? null,
        supplierIndex,
        note: item.note ?? null,
        overLimit: !!(category?.limitAmount && amount > category.limitAmount),
      };
    });
  }

  /** Ghi các dòng: có id thì sửa (giữ liên kết hoá đơn), thiếu thì xoá, mới thì thêm. */
  private async saveItems(
    manager: EntityManager,
    request: FinancialRequest,
    items: ComputedItem[],
    suppliers: FinancialRequestSupplier[] = [],
  ) {
    const repo = manager.getRepository(FinancialRequestItem);
    const supplierOf = (item: ComputedItem, line: number) => {
      if (item.supplierIndex === null) return null;
      const supplier = suppliers[item.supplierIndex];
      if (!supplier) {
        throw new BadRequestException(
          `Dòng ${line}: nhà cung cấp nhận tiền không tồn tại`,
        );
      }
      return supplier;
    };
    const existing = await repo.find({ where: { requestId: request.id } });
    const keepIds = new Set(items.filter((i) => i.id).map((i) => i.id));
    for (const item of items) {
      if (item.id && !existing.some((e) => e.id === item.id)) {
        throw new BadRequestException(
          `Dòng #${item.id} không thuộc chứng từ này`,
        );
      }
    }
    const removed = existing.filter((e) => !keepIds.has(e.id));
    if (removed.length) await repo.delete(removed.map((e) => e.id));
    let lineNo = 1;
    for (const item of items) {
      const current = item.id
        ? existing.find((e) => e.id === item.id)
        : undefined;
      const entity = current ?? repo.create({ requestId: request.id });
      const supplier = supplierOf(item, lineNo);
      Object.assign(entity, {
        lineNo: lineNo++,
        description: item.description,
        categoryId: item.categoryId,
        categoryName: item.categoryName,
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        amount: item.amount,
        incurredDate: item.incurredDate,
        invoiceNumber: item.invoiceNumber,
        invoiceType: item.invoiceType,
        // Gán NCC nhận tiền thì tên NCC của dòng theo danh sách NCC.
        supplierName: supplier ? supplier.name : item.supplierName,
        supplierId: supplier?.id ?? null,
        note: item.note,
        overLimit: item.overLimit,
        // Người đề nghị sửa lại sau khi bị trả về → số chấp nhận cũ không còn giá trị.
        approvedAmount: null,
        adjustmentReason: null,
        adjustedById: null,
        adjustedByName: null,
        adjustedAt: null,
      });
      await repo.save(entity);
    }
    request.totalAmount = sumMoney(items.map((i) => i.amount));
  }

  private loadSuppliers(manager: EntityManager, requestId: number) {
    return manager
      .getRepository(FinancialRequestSupplier)
      .find({ where: { requestId }, order: { lineNo: 'ASC', id: 'ASC' } });
  }

  /**
   * Ghi danh sách NCC nhận tiền (chỉ Thanh toán chi phí): có id thì sửa, thiếu
   * thì xoá (dòng chi tiết của NCC bị xoá quay về người đề nghị), mới thì thêm.
   * Trả về danh sách theo đúng thứ tự gửi lên để dòng chi tiết tra theo vị trí.
   */
  private async saveSuppliers(
    manager: EntityManager,
    request: FinancialRequest,
    dtoSuppliers: FinancialRequestSupplierDto[],
  ): Promise<FinancialRequestSupplier[]> {
    if (
      request.type !== FinancialRequestType.EXPENSE_PAYMENT &&
      dtoSuppliers.length
    ) {
      throw new BadRequestException(
        'Chỉ phiếu Thanh toán chi phí được chuyển tiền cho nhà cung cấp',
      );
    }
    const repo = manager.getRepository(FinancialRequestSupplier);
    const existing = await this.loadSuppliers(manager, request.id);
    for (const supplier of dtoSuppliers) {
      if (supplier.id && !existing.some((e) => e.id === supplier.id)) {
        throw new BadRequestException(
          `Nhà cung cấp #${supplier.id} không thuộc chứng từ này`,
        );
      }
    }
    const keepIds = new Set(dtoSuppliers.map((s) => s.id).filter(Boolean));
    const removed = existing.filter((e) => !keepIds.has(e.id));
    if (removed.length) await repo.delete(removed.map((e) => e.id));
    const saved: FinancialRequestSupplier[] = [];
    let lineNo = 1;
    for (const dto of dtoSuppliers) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException(`NCC ${lineNo}: nhập tên nhà cung cấp`);
      }
      const entity =
        (dto.id ? existing.find((e) => e.id === dto.id) : undefined) ??
        repo.create({ requestId: request.id });
      Object.assign(entity, {
        lineNo: lineNo++,
        name,
        bankAccountHolder: dto.bankAccountHolder?.trim() || null,
        bankName: dto.bankName?.trim() || null,
        bankAccountNumber: dto.bankAccountNumber?.trim() || null,
        note: dto.note?.trim() || null,
      });
      saved.push(await repo.save(entity));
    }
    return saved;
  }

  /** Đổi tên NCC mà không gửi lại dòng chi tiết → cập nhật tên NCC trên các dòng. */
  private async syncItemSupplierNames(
    manager: EntityManager,
    requestId: number,
  ) {
    await manager.query(
      `UPDATE "financial_request_items" i
         SET "supplier_name" = s."name"
        FROM "financial_request_suppliers" s
       WHERE s."id" = i."supplier_id"
         AND i."request_id" = $1
         AND i."supplier_name" IS DISTINCT FROM s."name"`,
      [requestId],
    );
  }

  private async saveAllocations(
    manager: EntityManager,
    request: FinancialRequest,
    allocations: AdvanceAllocationDto[],
  ) {
    await this.ledger.validateAllocations(manager, request, allocations);
    const repo = manager.getRepository(FinancialAdvanceAllocation);
    await repo.delete({ settlementId: request.id });
    if (allocations.length) {
      await repo.save(
        allocations.map((a) =>
          repo.create({
            settlementId: request.id,
            advanceId: a.advanceId,
            amount: a.amount,
          }),
        ),
      );
    }
    request.offsetAmount = sumMoney(allocations.map((a) => a.amount));
  }

  private async applyManager(
    manager: EntityManager,
    request: FinancialRequest,
    directManagerId: number | null | undefined,
  ) {
    if (directManagerId === undefined) return;
    if (directManagerId === null) {
      request.directManagerId = null;
      request.directManagerName = null;
      return;
    }
    if (directManagerId === request.requesterId) {
      throw new BadRequestException(
        'Không chọn chính mình làm quản lý trực tiếp',
      );
    }
    const eligible = await this.access.eligibleManagers(
      request.companyId,
      request.departmentId,
    );
    const chosen = eligible.find((e) => e.id === directManagerId);
    if (!chosen) {
      throw new BadRequestException(
        'Người được chọn không phải quản lý trực tiếp hợp lệ của phòng ban/công ty này',
      );
    }
    request.directManagerId = directManagerId;
    request.directManagerName = chosen.name ?? null;
  }

  private async expectedSalaryFor(
    manager: EntityManager,
    employeeId: number,
    year?: number | null,
    month?: number | null,
  ): Promise<number | null> {
    const qb = manager
      .getRepository(Payroll)
      .createQueryBuilder('p')
      .where('p.employee_id = :employeeId', { employeeId })
      .orderBy('p.year', 'DESC')
      .addOrderBy('p.month', 'DESC');
    if (year && month) {
      qb.andWhere('(p.year * 100 + p.month) <= :key', {
        key: year * 100 + month,
      });
    }
    const payroll = await qb.getOne();
    if (!payroll) return null;
    const value =
      payroll.baseSalary > 0 ? payroll.baseSalary : payroll.netSalary;
    return value > 0 ? Math.round(value) : null;
  }

  private async nextCode(manager: EntityManager, type: FinancialRequestType) {
    const prefix = REQUEST_CODE_PREFIX[type];
    const year = Number(vnToday().slice(0, 4));
    const [row] = await manager.query(
      `INSERT INTO "financial_document_sequences" ("prefix", "year", "last_number")
       VALUES ($1, $2, 1)
       ON CONFLICT ("prefix", "year")
       DO UPDATE SET "last_number" = "financial_document_sequences"."last_number" + 1
       RETURNING "last_number"`,
      [prefix, year],
    );
    return `${prefix}-${year}-${String(row.last_number).padStart(5, '0')}`;
  }

  async create(user: AuthUser, dto: CreateFinancialRequestDto) {
    const ctx = await this.access.context(user);
    if (
      dto.type === FinancialRequestType.INTERNAL_TRANSFER &&
      !this.access.canCreateTransfer(ctx)
    ) {
      throw new ForbiddenException(
        'Chỉ Kế toán, Thủ quỹ, Kế toán trưởng, Giám đốc được lập phiếu Điều chuyển tiền nội bộ',
      );
    }
    const id = await this.dataSource.transaction(async (manager) => {
      await this.assertCompany(manager, dto.companyId);
      const employee = await this.requesterSnapshot(manager, ctx.userId);
      const repo = manager.getRepository(FinancialRequest);
      const request = repo.create({
        type: dto.type,
        companyId: dto.companyId,
        requesterId: ctx.userId,
        requesterName: employee.name ?? ctx.name,
        requesterCode: `NV-${ctx.userId}`,
        requesterPosition: this.positionOf(employee),
        departmentId: employee.department?.id ?? null,
        departmentName: employee.department?.name ?? null,
        requestDate: dto.requestDate ?? vnToday(),
        title: dto.title.trim(),
        createdById: ctx.userId,
        createdByName: employee.name ?? ctx.name,
        approvalStatus: ApprovalStatus.DRAFT,
        paymentStatus: PaymentStatus.NONE,
        recoveryStatus: RecoveryStatus.NONE,
        settlementStatus: SettlementStatus.NONE,
        deductionStatus: DeductionStatus.NONE,
        totalAmount: 0,
        offsetAmount: 0,
        paidAmount: 0,
        recoveredAmount: 0,
        settledAmount: 0,
        deductedAmount: 0,
        currency: 'VND',
        version: 1,
      });
      this.applyHeader(request, dto);
      if (request.type === FinancialRequestType.INTERNAL_TRANSFER) {
        await this.assertTransferAccounts(manager, request, false);
      }
      if (!request.payeeName) request.payeeName = request.requesterName;
      if (
        request.type !== FinancialRequestType.INTERNAL_TRANSFER &&
        !dto.bankAccountNumber &&
        employee.bankAccountNumber
      ) {
        request.bankAccountNumber = employee.bankAccountNumber;
        request.bankName = request.bankName ?? employee.bankName ?? null;
        request.bankAccountHolder =
          request.bankAccountHolder ?? employee.name ?? null;
      }
      if (request.type === FinancialRequestType.SALARY_ADVANCE) {
        request.expectedSalary = await this.expectedSalaryFor(
          manager,
          ctx.userId,
          request.salaryYear,
          request.salaryMonth,
        );
      }
      request.code = await this.nextCode(manager, dto.type);
      await this.applyManager(manager, request, dto.directManagerId);
      await repo.save(request);

      const suppliers = await this.saveSuppliers(
        manager,
        request,
        dto.suppliers ?? [],
      );
      const items = await this.computeItems(
        manager,
        request,
        dto.items ?? [],
        dto.requestedAmount,
      );
      await this.saveItems(manager, request, items ?? [], suppliers);
      if (request.type === FinancialRequestType.SETTLEMENT) {
        await this.saveAllocations(manager, request, dto.allocations ?? []);
      }
      await repo.save(request);
      await writeAudit(manager, {
        requestId: request.id,
        action: AuditAction.CREATED,
        toStatus: request.approvalStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: {
          totalAmount: request.totalAmount,
          items: items?.length ?? 0,
          ...(suppliers.length ? { suppliers: suppliers.length } : {}),
        },
      });
      return request.id;
    });
    return this.detail(user, id);
  }

  private assertOwner(ctx: FinanceContext, request: FinancialRequest) {
    if (
      request.requesterId !== ctx.userId &&
      request.createdById !== ctx.userId
    ) {
      throw new ForbiddenException(
        'Chỉ người lập phiếu được thực hiện thao tác này',
      );
    }
  }

  async update(user: AuthUser, id: number, dto: UpdateFinancialRequestDto) {
    const ctx = await this.access.context(user);
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      this.assertOwner(ctx, request);
      if (!EDITABLE.includes(request.approvalStatus)) {
        throw new BadRequestException(
          'Chỉ sửa được bản nháp hoặc phiếu bị trả về',
        );
      }
      if (request.version !== dto.version) {
        throw new ConflictException(
          'Phiếu vừa được cập nhật ở nơi khác — tải lại trước khi lưu',
        );
      }
      const before = {
        totalAmount: request.totalAmount,
        title: request.title,
        companyId: request.companyId,
      };
      if (dto.companyId && dto.companyId !== request.companyId) {
        await this.assertCompany(manager, dto.companyId);
        request.companyId = dto.companyId;
        // Quản lý trực tiếp phụ thuộc công ty — phải chọn lại nếu không còn hợp lệ.
        if (request.directManagerId && dto.directManagerId === undefined) {
          dto.directManagerId = request.directManagerId;
        }
      }
      if (dto.title !== undefined) dto.title = dto.title.trim();
      this.applyHeader(request, dto);
      await this.applyManager(manager, request, dto.directManagerId);
      if (request.type === FinancialRequestType.SALARY_ADVANCE) {
        request.expectedSalary = await this.expectedSalaryFor(
          manager,
          request.requesterId,
          request.salaryYear,
          request.salaryMonth,
        );
      }

      let requestedAmount = dto.requestedAmount;
      if (
        request.type === FinancialRequestType.SALARY_ADVANCE &&
        requestedAmount === undefined &&
        (dto.salaryMonth !== undefined || dto.salaryYear !== undefined)
      ) {
        requestedAmount = request.totalAmount || undefined; // cập nhật lại diễn giải kỳ lương
      }
      if (request.type === FinancialRequestType.INTERNAL_TRANSFER) {
        await this.assertTransferAccounts(manager, request, false);
        if (
          requestedAmount === undefined &&
          (dto.transferFromAccountCode !== undefined ||
            dto.transferToAccountCode !== undefined)
        ) {
          requestedAmount = request.totalAmount || undefined; // cập nhật diễn giải nguồn
        }
      }
      const suppliers =
        dto.suppliers !== undefined
          ? await this.saveSuppliers(manager, request, dto.suppliers)
          : await this.loadSuppliers(manager, request.id);
      const items = await this.computeItems(
        manager,
        request,
        dto.items,
        requestedAmount,
      );
      if (items) await this.saveItems(manager, request, items, suppliers);
      else if (dto.suppliers !== undefined) {
        await this.syncItemSupplierNames(manager, request.id);
      }
      if (request.type === FinancialRequestType.SETTLEMENT && dto.allocations) {
        await this.saveAllocations(manager, request, dto.allocations);
      }
      request.version += 1;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.UPDATED,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: {
          fields: Object.keys(dto).filter(
            (k) => !['version', 'bankAccountNumber'].includes(k),
          ),
          bankAccountChanged: dto.bankAccountNumber !== undefined,
          ...(dto.suppliers !== undefined
            ? { suppliers: suppliers.map((s) => s.name) }
            : {}),
          before,
          after: {
            totalAmount: request.totalAmount,
            title: request.title,
            companyId: request.companyId,
          },
        },
      });
    });
    return this.detail(user, id);
  }

  async remove(user: AuthUser, id: number) {
    const ctx = await this.access.context(user);
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      this.assertOwner(ctx, request);
      if (request.approvalStatus !== ApprovalStatus.DRAFT) {
        throw new BadRequestException(
          'Chỉ xoá được bản nháp — phiếu đã gửi hãy thu hồi trước',
        );
      }
      request.deletedAt = new Date();
      request.approvalStatus = ApprovalStatus.CANCELLED;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.DELETED,
        fromStatus: ApprovalStatus.DRAFT,
        toStatus: ApprovalStatus.CANCELLED,
        actorId: ctx.userId,
        actorName: ctx.name,
      });
    });
    return { success: true };
  }

  async copy(user: AuthUser, id: number) {
    const ctx = await this.access.context(user);
    const source = await this.requestRepo.findOne({ where: { id } });
    if (!source || source.deletedAt)
      throw new NotFoundException('Không tìm thấy chứng từ');
    const steps = await this.stepRepo.find({ where: { requestId: id } });
    this.assertCanSee(ctx, source, steps);
    const items = await this.itemRepo.find({
      where: { requestId: id },
      order: { lineNo: 'ASC' },
    });
    // NCC là đối tác của công ty (không phải thông tin cá nhân) → luôn chép.
    const suppliers =
      source.type === FinancialRequestType.EXPENSE_PAYMENT
        ? await this.loadSuppliers(this.dataSource.manager, id)
        : [];
    const supplierIndex = new Map(suppliers.map((sp, index) => [sp.id, index]));
    const own = source.requesterId === ctx.userId;
    const dto: CreateFinancialRequestDto = {
      type: source.type,
      companyId: source.companyId,
      title: source.title,
      purpose: source.purpose,
      projectName: source.projectName,
      location: source.location,
      paymentNote: source.paymentNote,
      ...(own
        ? {
            directManagerId: source.directManagerId,
            payeeName: source.payeeName,
            bankAccountHolder: source.bankAccountHolder,
            bankName: source.bankName,
            bankAccountNumber: source.bankAccountNumber,
          }
        : {}),
      salaryYear: source.salaryYear ?? undefined,
      salaryMonth: source.salaryMonth ?? undefined,
      requestedAmount:
        source.type === FinancialRequestType.SALARY_ADVANCE ||
        source.type === FinancialRequestType.INTERNAL_TRANSFER
          ? source.totalAmount || undefined
          : undefined,
      transferFromAccountCode: source.transferFromAccountCode ?? undefined,
      transferToAccountCode: source.transferToAccountCode ?? undefined,
      deductionPeriods: source.deductionPeriods ?? undefined,
      items: items.map((i) => ({
        description: i.description,
        categoryId: i.categoryId,
        unit: i.unit,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        invoiceType: i.invoiceType,
        supplierName: i.supplierName,
        supplierIndex:
          i.supplierId !== null ? (supplierIndex.get(i.supplierId) ?? null) : null,
        note: i.note,
      })),
      suppliers: suppliers.map((sp) => ({
        name: sp.name,
        bankAccountHolder: sp.bankAccountHolder,
        bankName: sp.bankName,
        bankAccountNumber: sp.bankAccountNumber,
        note: sp.note,
      })),
    } as CreateFinancialRequestDto;
    try {
      const created = await this.create(user, dto);
      await this.dataSource.transaction(async (manager) => {
        await manager
          .getRepository(FinancialRequest)
          .update({ id: created.id }, { copiedFromId: source.id });
        await writeAudit(manager, {
          requestId: created.id,
          action: AuditAction.COPIED,
          actorId: ctx.userId,
          actorName: ctx.name,
          changes: { fromId: source.id, fromCode: source.code },
        });
      });
      return { ...created, copiedFromId: source.id };
    } catch (error) {
      if (error instanceof BadRequestException && own === false) {
        throw new BadRequestException(
          `Không sao chép được: ${(error.getResponse() as { message?: string }).message ?? error.message}`,
        );
      }
      throw error;
    }
  }

  // ===========================================================================
  // Gửi duyệt
  // ===========================================================================

  async policyFor(
    manager: EntityManager,
    companyId: number,
  ): Promise<FinancialPolicy> {
    const repo = manager.getRepository(FinancialPolicy);
    const specific = await repo.findOne({
      where: { scopeKey: `COMPANY:${companyId}` },
    });
    if (specific) return specific;
    const global = await repo.findOne({ where: { scopeKey: 'GLOBAL' } });
    return (
      global ??
      repo.create({
        scopeKey: 'GLOBAL',
        salaryAdvanceMaxPerMonth: null,
        salaryAdvanceMaxAmount: null,
        salaryAdvanceMaxPercent: null,
        maxDeductionPeriods: 1,
        advanceDueDays: 30,
        reminderDaysBefore: 3,
        expenseOverLimitMode: 'WARN',
      })
    );
  }

  /** Số phiếu ứng lương khác (đang chờ/đã duyệt) trong cùng kỳ lương. */
  private async salaryAdvancesInPeriod(
    manager: EntityManager,
    employeeId: number,
    year: number,
    month: number,
    excludeId?: number,
  ) {
    const qb = manager
      .getRepository(FinancialRequest)
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .andWhere('r.type = :type', { type: FinancialRequestType.SALARY_ADVANCE })
      .andWhere('r.requester_id = :employeeId', { employeeId })
      .andWhere('r.salary_year = :year AND r.salary_month = :month', {
        year,
        month,
      })
      .andWhere('r.approval_status IN (:...active)', {
        active: ACTIVE_APPROVAL_STATUSES,
      });
    if (excludeId) qb.andWhere('r.id <> :excludeId', { excludeId });
    return qb.getMany();
  }

  async salaryAdvanceCheck(user: AuthUser, query: SalaryAdvanceCheckQueryDto) {
    const ctx = await this.access.context(user);
    const manager = this.dataSource.manager;
    const [others, policy, expectedSalary] = await Promise.all([
      this.salaryAdvancesInPeriod(
        manager,
        ctx.userId,
        query.year,
        query.month,
        query.excludeRequestId,
      ),
      this.policyFor(manager, query.companyId),
      this.expectedSalaryFor(manager, ctx.userId, query.year, query.month),
    ]);
    return {
      expectedSalary,
      countInPeriod: others.length,
      pendingCount: others.filter(
        (r) => r.approvalStatus !== ApprovalStatus.APPROVED,
      ).length,
      approvedInPeriod: sumMoney(
        others
          .filter((r) => r.approvalStatus === ApprovalStatus.APPROVED)
          .map((r) => r.approvedAmount ?? r.totalAmount),
      ),
      requestedInPeriod: sumMoney(others.map((r) => r.totalAmount)),
      policy: {
        maxPerMonth: policy.salaryAdvanceMaxPerMonth,
        maxAmount: policy.salaryAdvanceMaxAmount,
        maxPercent: policy.salaryAdvanceMaxPercent,
        maxDeductionPeriods: policy.maxDeductionPeriods,
      },
    };
  }

  private async validateForSubmit(
    manager: EntityManager,
    request: FinancialRequest,
    items: FinancialRequestItem[],
    policy: FinancialPolicy,
  ) {
    const errors: string[] = [];
    if (!request.title?.trim()) errors.push('Thiếu nội dung đề nghị');
    if (!items.length) errors.push('Phải có ít nhất một khoản tiền');
    if (items.some((i) => i.amount <= 0))
      errors.push('Mỗi dòng phải có thành tiền lớn hơn 0');
    if (request.totalAmount <= 0) errors.push('Tổng tiền phải lớn hơn 0');
    if (
      policy.expenseOverLimitMode === 'BLOCK' &&
      items.some((i) => i.overLimit)
    ) {
      errors.push(
        'Có dòng chi vượt định mức danh mục — chính sách không cho gửi duyệt',
      );
    }

    switch (request.type) {
      case FinancialRequestType.INTERNAL_TRANSFER: {
        const accountErrors = await this.transferAccountErrors(manager, request);
        errors.push(...accountErrors);
        // Số tiền chuyển không vượt số dư nguồn theo Tổng hợp thu chi (hôm nay).
        if (!accountErrors.length && request.transferFromAccountCode && this.cashBalance) {
          try {
            await this.cashBalance.assertCovers(
              request.transferFromAccountCode,
              request.totalAmount,
            );
          } catch (error) {
            errors.push((error as Error).message);
          }
        }
        break;
      }
      case FinancialRequestType.ADVANCE:
        if (
          request.settlementDueDate &&
          request.settlementDueDate < request.requestDate
        ) {
          errors.push('Hạn hoàn ứng không được trước ngày đề nghị');
        }
        break;
      case FinancialRequestType.EXPENSE_PAYMENT:
        if (
          request.tripStartDate &&
          request.tripEndDate &&
          request.tripEndDate < request.tripStartDate
        ) {
          errors.push('Ngày kết thúc công tác phải sau ngày bắt đầu');
        }
        errors.push(
          ...supplierSubmitErrors(
            await this.loadSuppliers(manager, request.id),
            items,
          ),
        );
        break;
      case FinancialRequestType.SETTLEMENT: {
        const allocations = await manager
          .getRepository(FinancialAdvanceAllocation)
          .find({ where: { settlementId: request.id } });
        if (!allocations.length) {
          errors.push(
            'Hoàn ứng phải chọn ít nhất một phiếu tạm ứng — chi phí không dùng tạm ứng hãy lập Giấy đề nghị thanh toán',
          );
        }
        break;
      }
      case FinancialRequestType.SALARY_ADVANCE: {
        if (!request.salaryYear || !request.salaryMonth) {
          errors.push('Chọn tháng/năm lương ứng');
          break;
        }
        const others = await this.salaryAdvancesInPeriod(
          manager,
          request.requesterId,
          request.salaryYear,
          request.salaryMonth,
          request.id,
        );
        if (
          policy.salaryAdvanceMaxPerMonth &&
          others.length + 1 > policy.salaryAdvanceMaxPerMonth
        ) {
          errors.push(
            `Đã có ${others.length} phiếu ứng lương trong kỳ — tối đa ${policy.salaryAdvanceMaxPerMonth} lần/tháng`,
          );
        }
        if (
          policy.salaryAdvanceMaxAmount &&
          request.totalAmount > policy.salaryAdvanceMaxAmount
        ) {
          errors.push(
            `Số tiền ứng vượt hạn mức ${formatVnd(policy.salaryAdvanceMaxAmount)} đ`,
          );
        }
        if (policy.salaryAdvanceMaxPercent && request.expectedSalary) {
          const limit = Math.floor(
            (request.expectedSalary *
              Math.round(policy.salaryAdvanceMaxPercent * 100)) /
              10000,
          );
          const periodTotal =
            request.totalAmount +
            sumMoney(others.map((r) => r.approvedAmount ?? r.totalAmount));
          if (periodTotal > limit) {
            errors.push(
              `Tổng ứng trong kỳ vượt ${policy.salaryAdvanceMaxPercent}% lương dự kiến (tối đa ${formatVnd(limit)} đ)`,
            );
          }
        }
        if ((request.deductionPeriods ?? 1) > policy.maxDeductionPeriods) {
          errors.push(
            `Chỉ được chia khấu trừ tối đa ${policy.maxDeductionPeriods} kỳ`,
          );
        }
        break;
      }
    }
    if (errors.length) throw new BadRequestException(errors.join('; '));
  }

  async submit(user: AuthUser, id: number) {
    const ctx = await this.access.context(user);
    const notifications = await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      this.assertOwner(ctx, request);
      if (!EDITABLE.includes(request.approvalStatus)) {
        throw new BadRequestException(
          'Phiếu không ở trạng thái gửi duyệt được',
        );
      }
      const items = await manager
        .getRepository(FinancialRequestItem)
        .find({ where: { requestId: id }, order: { lineNo: 'ASC' } });
      const policy = await this.policyFor(manager, request.companyId);
      await this.validateForSubmit(manager, request, items, policy);

      if (request.type === FinancialRequestType.SETTLEMENT) {
        const allocations = await manager
          .getRepository(FinancialAdvanceAllocation)
          .find({ where: { settlementId: id } });
        await this.ledger.validateAllocations(
          manager,
          request,
          allocations.map((a) => ({
            advanceId: a.advanceId,
            amount: a.amount,
          })),
          { lock: true },
        );
      }
      if (
        request.type === FinancialRequestType.ADVANCE &&
        !request.settlementDueDate
      ) {
        request.settlementDueDate = addDays(
          request.expectedUseDate ?? request.requestDate,
          policy.advanceDueDays,
        );
      }
      if (request.type === FinancialRequestType.SALARY_ADVANCE) {
        request.deductionStartYear =
          request.deductionStartYear ?? request.salaryYear;
        request.deductionStartMonth =
          request.deductionStartMonth ?? request.salaryMonth;
        request.deductionPeriods = request.deductionPeriods ?? 1;
      }

      const workflows = await manager
        .getRepository(FinancialApprovalWorkflow)
        .find({
          where: { isActive: true },
        });
      const workflow = pickWorkflow(workflows, request.companyId, request.type);
      if (!workflow) {
        throw new BadRequestException(
          'Chưa có quy trình duyệt áp dụng cho công ty/loại chứng từ này — liên hệ quản trị',
        );
      }
      const definitions = await manager
        .getRepository(FinancialWorkflowStep)
        .find({
          where: { workflowId: workflow.id },
          order: { stepOrder: 'ASC' },
        });
      if (!definitions.length) {
        throw new BadRequestException(
          `Quy trình "${workflow.name}" chưa có cấp duyệt nào`,
        );
      }

      const resolved = new Map<
        number,
        { candidates: number[]; requesterWasCandidate: boolean }
      >();
      for (const definition of definitions) {
        resolved.set(
          definition.stepOrder,
          await this.access.resolveCandidates(
            definition,
            request,
            workflow.selfApprovalMode,
          ),
        );
      }
      let planned;
      try {
        planned = planSteps(
          definitions,
          request.totalAmount,
          workflow.selfApprovalMode,
          workflow.isSequential,
          resolved,
        );
      } catch (error) {
        if (error instanceof WorkflowPlanError)
          throw new BadRequestException(error.message);
        throw error;
      }

      const stepRepo = manager.getRepository(FinancialApprovalStep);
      await stepRepo
        .createQueryBuilder()
        .update()
        .set({ status: StepStatus.CANCELLED })
        .where('request_id = :id AND status IN (:...open)', {
          id,
          open: [StepStatus.WAITING, StepStatus.PENDING],
        })
        .execute();

      const round = request.currentRound + 1;
      const now = new Date();
      const created = await stepRepo.save(
        planned.map((p) =>
          stepRepo.create({
            requestId: id,
            round,
            stepOrder: p.definition.stepOrder,
            name: p.definition.name,
            signatureSlot: p.definition.signatureSlot,
            approverType: p.definition.approverType,
            approverRole: p.definition.approverRole,
            approverEmployeeId: p.definition.approverEmployeeId,
            minAmount: p.definition.minAmount,
            canAdjustAmounts: p.definition.canAdjustAmounts,
            skippable: p.definition.skippable,
            candidateApproverIds: p.candidates,
            status: p.status,
            comment: p.comment,
            activatedAt: p.status === StepStatus.PENDING ? now : null,
            actedAt: p.status === StepStatus.SKIPPED ? now : null,
          }),
        ),
      );

      const from = request.approvalStatus;
      request.approvalStatus = ApprovalStatus.PENDING;
      request.currentRound = round;
      request.submittedAt = now;
      request.workflowId = workflow.id;
      request.workflowName = workflow.name;
      request.isSequential = workflow.isSequential;
      // Tài khoản thanh toán do thủ quỹ chọn khi chi; vòng duyệt mới bỏ lựa chọn cũ.
      request.paymentAccountCode = null;
      request.version += 1;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.SUBMITTED,
        fromStatus: from,
        toStatus: request.approvalStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: {
          round,
          workflow: workflow.name,
          totalAmount: request.totalAmount,
          skipped: created
            .filter((s) => s.status === StepStatus.SKIPPED)
            .map((s) => ({ step: s.name, reason: s.comment })),
        },
      });

      if (!created.some((s) => s.status === StepStatus.PENDING)) {
        await this.finalizeApproval(manager, request, ctx);
        return {
          request,
          approved: true,
          pending: [] as FinancialApprovalStep[],
        };
      }
      return {
        request,
        approved: false,
        pending: created.filter((s) => s.status === StepStatus.PENDING),
      };
    });

    if (notifications.approved) {
      await this.afterFinalApproval(notifications.request, ctx.userId);
    } else {
      for (const step of notifications.pending) {
        await this.notifier.approvalRequired(
          step.candidateApproverIds,
          notifications.request,
          step.name,
          ctx.userId,
        );
      }
    }
    return this.detail(user, id);
  }

  // ===========================================================================
  // Duyệt / trả về / từ chối / thu hồi
  // ===========================================================================

  private async lockActionableStep(
    manager: EntityManager,
    ctx: FinanceContext,
    request: FinancialRequest,
    stepId: number,
  ) {
    if (request.approvalStatus !== ApprovalStatus.PENDING) {
      throw new ConflictException('Phiếu không còn ở trạng thái chờ duyệt');
    }
    const step = await manager.getRepository(FinancialApprovalStep).findOne({
      where: { id: stepId, requestId: request.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!step || step.round !== request.currentRound) {
      throw new ConflictException('Bước duyệt không thuộc vòng duyệt hiện tại');
    }
    if (step.status !== StepStatus.PENDING) {
      throw new ConflictException('Bước này đã được xử lý hoặc chưa tới lượt');
    }
    const { eligible, onBehalfOfId } = this.access.eligibility(
      ctx,
      request,
      step,
    );
    if (!eligible) {
      throw new ForbiddenException('Bạn không phải người duyệt của bước này');
    }
    let onBehalfOfName: string | null = null;
    if (onBehalfOfId) {
      const delegator = await manager
        .getRepository(Employee)
        .findOne({ where: { id: onBehalfOfId }, select: ['id', 'name'] });
      onBehalfOfName = delegator?.name ?? `#${onBehalfOfId}`;
    }
    return { step, onBehalfOfId, onBehalfOfName };
  }

  private async applyAdjustments(
    manager: EntityManager,
    ctx: FinanceContext,
    request: FinancialRequest,
    step: FinancialApprovalStep,
    adjustments: ItemAdjustmentDto[],
  ) {
    if (!adjustments.length) return;
    if (!step.canAdjustAmounts) {
      throw new ForbiddenException(
        'Cấp duyệt này không được điều chỉnh số tiền',
      );
    }
    const repo = manager.getRepository(FinancialRequestItem);
    const items = await repo.find({ where: { requestId: request.id } });
    const changes: Record<string, unknown>[] = [];
    for (const adjustment of adjustments) {
      const item = items.find((i) => i.id === adjustment.itemId);
      if (!item)
        throw new BadRequestException(
          `Dòng #${adjustment.itemId} không thuộc phiếu`,
        );
      if (adjustment.approvedAmount > item.amount) {
        throw new BadRequestException(
          `Dòng ${item.lineNo}: số chấp nhận không được lớn hơn số kê khai`,
        );
      }
      if (
        adjustment.approvedAmount !== item.amount &&
        !adjustment.reason?.trim()
      ) {
        throw new BadRequestException(
          `Dòng ${item.lineNo}: phải ghi lý do điều chỉnh`,
        );
      }
      const before = item.approvedAmount ?? item.amount;
      if (before === adjustment.approvedAmount && item.approvedAmount !== null)
        continue;
      item.approvedAmount = adjustment.approvedAmount;
      item.adjustmentReason = adjustment.reason?.trim() || null;
      item.adjustedById = ctx.userId;
      item.adjustedByName = ctx.name;
      item.adjustedAt = new Date();
      await repo.save(item);
      changes.push({
        line: item.lineNo,
        description: item.description,
        declared: item.amount,
        before,
        after: adjustment.approvedAmount,
        reason: item.adjustmentReason,
      });
    }
    if (changes.length) {
      await writeAudit(manager, {
        requestId: request.id,
        action: AuditAction.AMOUNTS_ADJUSTED,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: { step: step.name, lines: changes },
      });
    }
  }

  async adjust(user: AuthUser, id: number, dto: AdjustItemsDto) {
    const ctx = await this.access.context(user);
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      const { step } = await this.lockActionableStep(
        manager,
        ctx,
        request,
        dto.stepId,
      );
      await this.applyAdjustments(manager, ctx, request, step, dto.adjustments);
    });
    return this.detail(user, id);
  }

  /** Mở bước kế tiếp (tuần tự) hoặc chốt duyệt khi đã hết bước. */
  private async advance(
    manager: EntityManager,
    ctx: FinanceContext,
    request: FinancialRequest,
  ): Promise<{ approved: boolean; activated: FinancialApprovalStep[] }> {
    const stepRepo = manager.getRepository(FinancialApprovalStep);
    const steps = await stepRepo.find({
      where: { requestId: request.id, round: request.currentRound },
    });
    const { toActivate, finished } = nextStepsAfterDecision(
      steps,
      request.isSequential,
    );
    if (finished) {
      await this.finalizeApproval(manager, request, ctx);
      return { approved: true, activated: [] };
    }
    const workflow = request.workflowId
      ? await manager
          .getRepository(FinancialApprovalWorkflow)
          .findOne({ where: { id: request.workflowId } })
      : null;
    for (const step of toActivate) {
      // Tính lại người duyệt theo phân quyền mới nhất; rỗng thì giữ danh sách lúc gửi.
      const { candidates } = await this.access.resolveCandidates(
        step,
        request,
        workflow?.selfApprovalMode ?? SelfApprovalMode.BLOCK,
      );
      if (candidates.length) step.candidateApproverIds = candidates;
      step.status = StepStatus.PENDING;
      step.activatedAt = new Date();
      await stepRepo.save(step);
    }
    return { approved: false, activated: toActivate };
  }

  private async finalizeApproval(
    manager: EntityManager,
    request: FinancialRequest,
    ctx: Pick<FinanceContext, 'userId' | 'name'>,
  ) {
    const items = await manager
      .getRepository(FinancialRequestItem)
      .find({ where: { requestId: request.id } });
    request.approvedAmount = sumMoney(
      items.map((i) => i.approvedAmount ?? i.amount),
    );
    const from = request.approvalStatus;
    request.approvalStatus = ApprovalStatus.APPROVED;
    request.approvedAt = new Date();
    if (request.type === FinancialRequestType.SETTLEMENT) {
      await this.ledger.applySettlement(manager, request, {
        id: ctx.userId,
        name: ctx.name,
      });
    } else {
      request.paymentStatus =
        request.approvedAmount > 0 ? PaymentStatus.UNPAID : PaymentStatus.NONE;
    }
    request.version += 1;
    await manager.getRepository(FinancialRequest).save(request);
    await writeAudit(manager, {
      requestId: request.id,
      action: AuditAction.APPROVED,
      fromStatus: from,
      toStatus: ApprovalStatus.APPROVED,
      actorId: ctx.userId,
      actorName: ctx.name,
      changes: {
        approvedAmount: request.approvedAmount,
        totalAmount: request.totalAmount,
        ...(request.type === FinancialRequestType.SETTLEMENT
          ? {
              offsetAmount: request.offsetAmount,
              difference: request.approvedAmount - request.offsetAmount,
              settlementStatus: request.settlementStatus,
            }
          : {}),
      },
    });
    if (request.settlementStatus === SettlementStatus.COMPLETED) {
      await writeAudit(manager, {
        requestId: request.id,
        action: AuditAction.SETTLEMENT_COMPLETED,
        actorId: ctx.userId,
        actorName: ctx.name,
      });
    }
  }

  private async afterFinalApproval(request: FinancialRequest, actorId: number) {
    await this.notifier.approved(request, actorId);
    await this.notifier.paymentPending(
      request,
      payableDue(request) - request.paidAmount,
      actorId,
    );
  }

  async approve(user: AuthUser, id: number, dto: ApproveStepDto) {
    const ctx = await this.access.context(user);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      const { step, onBehalfOfId, onBehalfOfName } =
        await this.lockActionableStep(manager, ctx, request, dto.stepId);
      await this.applyAdjustments(
        manager,
        ctx,
        request,
        step,
        dto.adjustments ?? [],
      );
      step.status = StepStatus.APPROVED;
      step.actedById = ctx.userId;
      step.actedByName = ctx.name;
      step.onBehalfOfId = onBehalfOfId;
      step.onBehalfOfName = onBehalfOfName;
      step.actedAt = new Date();
      step.comment = dto.comment?.trim() || null;
      await manager.getRepository(FinancialApprovalStep).save(step);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.APPROVED_STEP,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: step.comment,
        changes: {
          step: step.name,
          stepOrder: step.stepOrder,
          round: step.round,
          ...(onBehalfOfName ? { onBehalfOf: onBehalfOfName } : {}),
        },
      });
      const result = await this.advance(manager, ctx, request);
      return { request, ...result };
    });

    if (outcome.approved) {
      await this.afterFinalApproval(outcome.request, ctx.userId);
    } else {
      for (const step of outcome.activated) {
        await this.notifier.approvalRequired(
          step.candidateApproverIds,
          outcome.request,
          step.name,
          ctx.userId,
        );
        await this.notifier.nextLevel(outcome.request, step.name, ctx.userId);
      }
    }
    return this.detail(user, id);
  }

  private async closeRound(
    manager: EntityManager,
    request: FinancialRequest,
    decided: FinancialApprovalStep,
  ) {
    await manager
      .getRepository(FinancialApprovalStep)
      .createQueryBuilder()
      .update()
      .set({ status: StepStatus.CANCELLED })
      .where(
        'request_id = :id AND round = :round AND id <> :stepId AND status IN (:...open)',
        {
          id: request.id,
          round: request.currentRound,
          stepId: decided.id,
          open: [StepStatus.WAITING, StepStatus.PENDING],
        },
      )
      .execute();
  }

  async reject(user: AuthUser, id: number, dto: DecideStepDto) {
    return this.decide(user, id, dto, 'REJECT');
  }

  async returnForChanges(user: AuthUser, id: number, dto: DecideStepDto) {
    return this.decide(user, id, dto, 'RETURN');
  }

  private async decide(
    user: AuthUser,
    id: number,
    dto: DecideStepDto,
    decision: 'REJECT' | 'RETURN',
  ) {
    dto.comment = requireText(dto.comment, 'Vui lòng nhập ý kiến/lý do');
    const ctx = await this.access.context(user);
    const request = await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      const { step, onBehalfOfId, onBehalfOfName } =
        await this.lockActionableStep(manager, ctx, request, dto.stepId);
      step.status =
        decision === 'REJECT' ? StepStatus.REJECTED : StepStatus.RETURNED;
      step.actedById = ctx.userId;
      step.actedByName = ctx.name;
      step.onBehalfOfId = onBehalfOfId;
      step.onBehalfOfName = onBehalfOfName;
      step.actedAt = new Date();
      step.comment = dto.comment;
      await manager.getRepository(FinancialApprovalStep).save(step);
      await this.closeRound(manager, request, step);
      const from = request.approvalStatus;
      if (decision === 'REJECT') {
        request.approvalStatus = ApprovalStatus.REJECTED;
        request.rejectedAt = new Date();
      } else {
        request.approvalStatus = ApprovalStatus.RETURNED;
      }
      request.version += 1;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action:
          decision === 'REJECT' ? AuditAction.REJECTED : AuditAction.RETURNED,
        fromStatus: from,
        toStatus: request.approvalStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.comment,
        changes: { step: step.name, round: step.round },
      });
      return request;
    });
    await this.notifier.notify(
      [request.requesterId],
      request,
      decision === 'REJECT' ? 'REJECTED' : 'RETURNED',
      decision === 'REJECT'
        ? `${request.code} bị từ chối: ${dto.comment}`
        : `${request.code} cần bổ sung: ${dto.comment}`,
      ctx.userId,
    );
    return this.detail(user, id);
  }

  async withdraw(user: AuthUser, id: number, dto: WithdrawDto) {
    const ctx = await this.access.context(user);
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      this.assertOwner(ctx, request);
      if (request.approvalStatus !== ApprovalStatus.PENDING) {
        throw new BadRequestException('Chỉ thu hồi được phiếu đang chờ duyệt');
      }
      const workflow = request.workflowId
        ? await manager
            .getRepository(FinancialApprovalWorkflow)
            .findOne({ where: { id: request.workflowId } })
        : null;
      if (workflow && !workflow.allowWithdraw) {
        throw new ForbiddenException('Quy trình này không cho phép thu hồi');
      }
      await manager
        .getRepository(FinancialApprovalStep)
        .createQueryBuilder()
        .update()
        .set({ status: StepStatus.CANCELLED })
        .where('request_id = :id AND round = :round AND status IN (:...open)', {
          id,
          round: request.currentRound,
          open: [StepStatus.WAITING, StepStatus.PENDING],
        })
        .execute();
      request.approvalStatus = ApprovalStatus.DRAFT;
      request.version += 1;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.WITHDRAWN,
        fromStatus: ApprovalStatus.PENDING,
        toStatus: ApprovalStatus.DRAFT,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.reason ?? null,
      });
    });
    return this.detail(user, id);
  }

  /** Quản trị bỏ qua một cấp được phép bỏ qua (bắt buộc lý do). */
  async skipStep(user: AuthUser, id: number, stepId: number, dto: ReasonDto) {
    dto.reason = requireText(
      dto.reason,
      'Vui lòng nhập lý do bỏ qua cấp duyệt',
    );
    const ctx = await this.access.context(user);
    this.access.assertAdmin(ctx);
    const outcome = await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      if (request.approvalStatus !== ApprovalStatus.PENDING) {
        throw new ConflictException('Phiếu không còn ở trạng thái chờ duyệt');
      }
      const step = await manager.getRepository(FinancialApprovalStep).findOne({
        where: { id: stepId, requestId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !step ||
        step.round !== request.currentRound ||
        step.status !== StepStatus.PENDING
      ) {
        throw new ConflictException('Bước này không còn chờ xử lý');
      }
      if (!step.skippable)
        throw new ForbiddenException('Cấp này không được phép bỏ qua');
      step.status = StepStatus.SKIPPED;
      step.actedById = ctx.userId;
      step.actedByName = ctx.name;
      step.actedAt = new Date();
      step.comment = `Bỏ qua: ${dto.reason}`;
      await manager.getRepository(FinancialApprovalStep).save(step);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.STEP_SKIPPED,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.reason,
        changes: { step: step.name, round: step.round },
      });
      const result = await this.advance(manager, ctx, request);
      return { request, ...result };
    });
    if (outcome.approved) {
      await this.afterFinalApproval(outcome.request, ctx.userId);
    } else {
      for (const step of outcome.activated) {
        await this.notifier.approvalRequired(
          step.candidateApproverIds,
          outcome.request,
          step.name,
          ctx.userId,
        );
      }
    }
    return this.detail(user, id);
  }

  /**
   * Huỷ phiếu ĐÃ DUYỆT nhưng chưa phát sinh tiền (bắt buộc lý do; bằng chứng
   * đính kèm loại ADJUSTMENT_EVIDENCE). Đã chi/thu/khấu trừ thì phải huỷ các
   * phiếu chi/thu trước.
   */
  async cancel(user: AuthUser, id: number, dto: ReasonDto) {
    dto.reason = requireText(dto.reason, 'Vui lòng nhập lý do huỷ');
    const ctx = await this.access.context(user);
    const request = await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      if (
        !ctx.isAdmin &&
        !this.access.hasRole(
          ctx,
          FinanceRole.ACCOUNTANT,
          request.companyId,
          request.departmentId,
        )
      ) {
        throw new ForbiddenException(
          'Chỉ kế toán hoặc quản trị được huỷ phiếu đã duyệt',
        );
      }
      if (request.approvalStatus !== ApprovalStatus.APPROVED) {
        throw new BadRequestException(
          'Chỉ huỷ phiếu đã duyệt (bản nháp thì xoá, đang chờ thì từ chối/thu hồi)',
        );
      }
      if (await this.ledger.hasMoneyMovements(manager, request)) {
        throw new BadRequestException(
          'Phiếu đã phát sinh chi/thu/khấu trừ hoặc đang được hoàn ứng — xử lý các khoản đó trước',
        );
      }
      if (request.type === FinancialRequestType.SETTLEMENT) {
        await this.ledger.revertSettlement(manager, request);
      }
      await manager
        .getRepository(FinancialSalaryAdvanceDeduction)
        .delete({ requestId: id, status: DeductionRowStatus.PLANNED });
      const before = request.approvalStatus;
      request.approvalStatus = ApprovalStatus.CANCELLED;
      request.paymentStatus = PaymentStatus.NONE;
      request.recoveryStatus = RecoveryStatus.NONE;
      request.settlementStatus = SettlementStatus.NONE;
      request.deductionStatus = DeductionStatus.NONE;
      request.cancelledAt = new Date();
      request.cancelReason = dto.reason;
      request.version += 1;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.CANCELLED,
        fromStatus: before,
        toStatus: ApprovalStatus.CANCELLED,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.reason,
      });
      return request;
    });
    await this.notifier.notify(
      [request.requesterId],
      request,
      'CANCELLED',
      `${request.code} đã bị huỷ: ${dto.reason}`,
      ctx.userId,
    );
    return this.detail(user, id);
  }

  // ===========================================================================
  // Đính kèm
  // ===========================================================================

  private canDeleteAttachment(
    ctx: FinanceContext,
    request: FinancialRequest,
    attachment: FinancialRequestAttachment,
  ) {
    if (ctx.isAdmin) return true;
    if (attachment.uploadedById !== ctx.userId) return false;
    if (
      [AttachmentKind.DOCUMENT, AttachmentKind.INVOICE].includes(
        attachment.kind,
      )
    ) {
      return EDITABLE.includes(request.approvalStatus);
    }
    return false;
  }

  async uploadAttachments(
    user: AuthUser,
    id: number,
    files: Express.Multer.File[],
    dto: UploadAttachmentDto,
  ) {
    const ctx = await this.access.context(user);
    if (!files?.length) throw new BadRequestException('Chưa chọn tệp');
    if (files.length > ATTACHMENT_MAX_FILES) {
      throw new BadRequestException(
        `Tối đa ${ATTACHMENT_MAX_FILES} tệp mỗi lần`,
      );
    }
    const kind = dto.kind ?? AttachmentKind.DOCUMENT;
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      const isOwner =
        request.requesterId === ctx.userId ||
        request.createdById === ctx.userId;
      if (kind === AttachmentKind.DOCUMENT || kind === AttachmentKind.INVOICE) {
        if (!isOwner || !EDITABLE.includes(request.approvalStatus)) {
          throw new ForbiddenException(
            'Chỉ người lập phiếu bổ sung chứng từ khi phiếu là nháp hoặc bị trả về',
          );
        }
      } else if (kind === AttachmentKind.ADJUSTMENT_EVIDENCE) {
        if (
          !ctx.isAdmin &&
          !this.access.hasRole(
            ctx,
            FinanceRole.ACCOUNTANT,
            request.companyId,
            request.departmentId,
          )
        ) {
          throw new ForbiddenException(
            'Chỉ kế toán/quản trị đính kèm bằng chứng điều chỉnh',
          );
        }
      } else if (kind === AttachmentKind.CONTROL_EVIDENCE) {
        // Tải lên trước khi bấm duyệt: phải đang là người duyệt cấp kiểm soát.
        const pending =
          request.approvalStatus === ApprovalStatus.PENDING
            ? await manager.getRepository(FinancialApprovalStep).find({
                where: {
                  requestId: id,
                  round: request.currentRound,
                  status: StepStatus.PENDING,
                },
              })
            : [];
        const canAttach = pending.some(
          (step) =>
            isControllerApprovalStep(step) &&
            this.access.eligibility(ctx, request, step).eligible,
        );
        if (!canAttach) {
          throw new ForbiddenException(
            'Chỉ người duyệt cấp Bộ phận kiểm soát đính kèm chứng từ kiểm soát, khi phiếu đang chờ cấp đó',
          );
        }
      } else if (!this.access.canRecordMoney(ctx, request)) {
        throw new ForbiddenException(
          'Bạn không có quyền đính kèm chứng từ thanh toán',
        );
      }
      if (dto.itemId) {
        const item = await manager
          .getRepository(FinancialRequestItem)
          .findOne({ where: { id: dto.itemId, requestId: id } });
        if (!item)
          throw new BadRequestException('Dòng chi phí không thuộc phiếu');
      }
      if (dto.paymentId) {
        const payment = await manager
          .getRepository(FinancialPayment)
          .findOne({ where: { id: dto.paymentId, requestId: id } });
        if (!payment)
          throw new BadRequestException('Phiếu chi không thuộc chứng từ');
      }
      if (dto.refundId) {
        const refund = await manager
          .getRepository(FinancialRefund)
          .findOne({ where: { id: dto.refundId, requestId: id } });
        if (!refund)
          throw new BadRequestException('Phiếu thu không thuộc chứng từ');
      }
      const repo = manager.getRepository(FinancialRequestAttachment);
      const saved: string[] = [];
      for (const file of files) {
        const stored = await storeFile(file, `requests/${id}`);
        await repo.save(
          repo.create({
            requestId: id,
            itemId: dto.itemId ?? null,
            paymentId: dto.paymentId ?? null,
            refundId: dto.refundId ?? null,
            kind,
            ...stored,
            uploadedById: ctx.userId,
            uploadedByName: ctx.name,
          }),
        );
        saved.push(stored.originalName);
      }
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.ATTACHMENT_ADDED,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: { kind, files: saved, itemId: dto.itemId ?? null },
      });
    });
    return this.detail(user, id);
  }

  async removeAttachment(user: AuthUser, id: number, attachmentId: number) {
    const ctx = await this.access.context(user);
    await this.dataSource.transaction(async (manager) => {
      const request = await this.ledger.lockRequest(manager, id);
      const repo = manager.getRepository(FinancialRequestAttachment);
      const attachment = await repo.findOne({
        where: { id: attachmentId, requestId: id },
      });
      if (!attachment || attachment.deletedAt)
        throw new NotFoundException('Không tìm thấy tệp');
      if (!this.canDeleteAttachment(ctx, request, attachment)) {
        throw new ForbiddenException('Bạn không được xoá tệp này');
      }
      attachment.deletedAt = new Date();
      attachment.deletedById = ctx.userId;
      await repo.save(attachment);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.ATTACHMENT_REMOVED,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: { file: attachment.originalName, kind: attachment.kind },
      });
    });
    return this.detail(user, id);
  }

  async attachmentFile(user: AuthUser, id: number, attachmentId: number) {
    const ctx = await this.access.context(user);
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request || request.deletedAt)
      throw new NotFoundException('Không tìm thấy chứng từ');
    const steps = await this.stepRepo.find({ where: { requestId: id } });
    this.assertCanSee(ctx, request, steps);
    const attachment = await this.attachmentRepo.findOne({
      where: { id: attachmentId, requestId: id },
    });
    if (!attachment || attachment.deletedAt)
      throw new NotFoundException('Không tìm thấy tệp');
    return { attachment, stream: openStoredFile(attachment.storagePath) };
  }

  /** Nạp đủ dữ liệu cho PDF/Excel (đã kiểm tra quyền xem). */
  async loadForExport(user: AuthUser, id: number) {
    const detail = await this.detail(user, id);
    const company = await this.companyRepo.findOne({
      where: { id: detail.companyId },
    });
    return { detail, company };
  }
}
