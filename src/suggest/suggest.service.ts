import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import {
  Repository,
  DataSource,
  EntityManager,
  In,
  Not,
  SelectQueryBuilder,
} from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Suggest } from './entities/suggest.entity';
import { SuggestHistory } from './entities/suggest-history.entity';
import { CreateSuggestDto } from './dto/create-suggest.dto';
import type { MonthlyCashflowItemDto } from './dto/expense/create-expense-request.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SuggestCreatedEvent } from './events/suggest-created.event';

import { SuggestStatus, EXPENSE_TERMINAL_STATUSES } from './SuggestStatus.enum';
import { SuggestReviewedEvent } from './events/suggest-reviewed.event';
import { SuggestApprovedEvent } from './events/suggest-approved.event';
import { Employee } from '../employee/employee.entity';
import { Policy } from '../policy/entities/policy.entity';
import { School } from '../school/schools.entity';
import { Ward } from '../ward/ward.entity';
import { EmployeeRegion } from '../employee-region-school/entities/employee-region.entity';
import { Subject } from '../subject/subject.entity';
import { ExpensePeriod } from '../expense-periods/expense-period.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import {
  CASHFLOW_READ_ROLES,
  CASHFLOW_TEACHER_PAY_ROLES,
} from '../school-expenses/cashflow-roles';
import { SchoolTeacher } from '../school-teacher-expense/school-teacher.entity';
import {
  ACCOUNTANT_CHAIN,
  CASHFLOW_RELEASED_STATUSES,
  CASHFLOW_SOURCE_LABELS,
  CASHFLOW_SOURCES,
  SALES_PICK,
  SALES_PICK_SOURCE_LABELS,
  CASHFLOW_TABLE_LABELS,
  type CashflowGroup,
  type CashflowItemRef,
  type CashflowPaidRow,
  type CashflowSource,
  actorSchoolIds,
  cashflowGroupLabel,
  cashflowItemKey,
  cashflowItemStatus,
  cashflowSourceOf,
  isAccountantChain,
  isCashflowSource,
  isMonthlyChain,
  isSalesPick,
  itemSourceOf,
  loadOpenCashflowRequests,
  cashTakerOf,
  type CashInput,
  multiAccounts,
  sumByAccount,
  loadSchoolExpenseGroups,
  loadSchoolTeacherGroups,
  lockCashflowKeys,
  managementGroupsFromSections,
  periodLabelOf,
  recordSchoolExpenseSuggestPayments,
  recordSchoolTeacherSuggestPayments,
  schoolYearOfPeriod,
} from './cashflow-sources';
import {
  loadPolicySupport,
  policySupportRowKey,
  type PolicySupportUsage,
} from './policy-support';
import { SuggestPolicySupportItem } from './entities/suggest-policy-support-item.entity';

/** Dòng chính sách đã kiểm, sẵn để lưu vào `suggest_policy_support_items`. */
interface PolicySupportSelection {
  policyId: number;
  subjectId: number;
  subjectName: string | null;
  supportType: 'CASH' | 'EQUIPMENT';
  itemIndex: number;
  label: string;
  policyAmount: number;
  amount: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const policySelectionLog = (selections: PolicySupportSelection[]) =>
  selections.length
    ? {
        policySupport: {
          total: Math.round(selections.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
          items: selections.map((item) => ({
            label: [item.subjectName, item.label].filter(Boolean).join(' · '),
            amount: item.amount,
          })),
        },
      }
    : {};
import { loadSheetRows } from './cashflow-sheet';
import {
  buildManagementViewSections,
  ManagementViewSection,
  ManagementViewSuggestPayments,
} from './expense-management-view';
import { loadManagementConfirmations } from '../school-expenses/management-confirmations';
import {
  allocateSuggestPayment,
  loadSuggestPayments,
  suggestCodesLabel,
  SUGGEST_PAYMENT_TABLES,
} from '../management-expense-item/suggest-payments';
import {
  formatMoneyVnd,
  monthlyItemAmounts,
  monthlyItemLabel,
  monthlyItemsFromColumns,
  MonthlyItemInput,
  monthlyRemainingTotal,
  partialSpendSummary,
  selectApprovedItems,
} from './monthly-expense-items';
import fixVietnamese from '../utils/fixVietnamese';
import { NotificationService } from '../notifications/services/notification.service';
import { SuggestGateway } from './suggest.gateway';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmToken } from '../employee-fcm-token/employee-fcm-token.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';

// ===== ĐỀ XUẤT CHI (EXPENSE_REQUEST) =====
import { SuggestType } from './enums/suggest-type.enum';
import { ExpenseAction } from './enums/expense-action.enum';
import {
  EXPENSE_REQUESTER_ROLES,
  ExpenseRole,
} from './constants/expense-roles';
import {
  EXPENSE_TRANSITIONS,
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import { SuggestPaymentOrder } from './entities/suggest-payment-order.entity';
import { SuggestMonthlyItem } from './entities/suggest-monthly-item.entity';
import { SuggestStockIssueOrder } from './entities/suggest-stock-issue-order.entity';
import { PaymentMethod } from './enums/expense-payment-method.enum';
import {
  StockInItem,
  SuggestStockInOrder,
} from './entities/suggest-stock-in-order.entity';
import { CreateStockInReceiptDto } from './dto/expense/create-stock-in-receipt.dto';
import {
  AssignmentRole,
  AssignmentStatus,
  SuggestAssignment,
} from './entities/suggest-assignment.entity';
import { WarehouseService } from '../warehouse/warehouse.service';
import { WarehouseReceipt } from '../warehouse/entities/warehouse-receipt.entity';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';
import { EquipmentSource } from './enums/equipment-source.enum';
import { CreateStockIssueOrderDto } from './dto/expense/create-stock-issue-order.dto';
import { SuggestAttachment } from './entities/suggest-attachment.entity';
import {
  DEFAULT_EXPENSE_REMINDERS_ENABLED,
  DEFAULT_REMIND_BEFORE_DAYS,
  EXPENSE_REMINDERS_ENABLED_KEY,
  REMIND_BEFORE_DAYS_KEY,
  SuggestReminderSetting,
} from './entities/suggest-reminder-setting.entity';
import { CreatePaymentOrderDto } from './dto/expense/create-payment-order.dto';
import {
  FundSource,
  FUND_SOURCE_LABEL,
  fundSourceOfCashAccount,
} from './enums/expense-fund-source.enum';
import { cashAccountLabel } from '../revenue-item/invoice-cash-account';
import {
  type CashSplit,
  cashSplitsLabel,
  createCashSplitCursor,
  normalizeCashSplits,
  orderCashSplits,
  returnCashSplits,
} from './cash-splits';
import { UpdateExpenseRequestDto } from './dto/expense/update-expense-request.dto';
import { FilterExpenseDto } from './dto/expense/filter-expense.dto';
import { ApproveExpenseDto } from './dto/expense/approve-expense.dto';
import { vnToday, vnYearMonth, diffDays, currentSchoolYear, isValidSchoolYear } from './utils/vn-date';
import { isCronLeader } from '../utils/is-cron-leader';

export interface AuthUser {
  id: number;
  roles: string[];
  name?: string;
}

export interface UploadedAttachment {
  fileUrl: string;
  fileName: string;
}

/** Ghi vào lịch sử đề xuất: phần Đã chi đã ghi sang bảng Chi Ngoài. */
type ChiNgoaiPaymentLog =
  | { skipped: string; paidDate?: undefined; cashAccount?: undefined; items?: undefined }
  | {
      skipped?: undefined;
      paidDate: string;
      cashAccount: string | null;
      /** Nhiều nguồn chi: số tiền đã ghi theo từng tài khoản. */
      cashAccounts?: { cashAccount: string | null; amount: number }[];
      items: {
        monthlyItemId: number;
        label: string;
        amount: number;
        /** Bảng không còn dòng nào để ghi. */
        unallocated: number;
        rows: {
          itemId: number;
          schoolExpenseId: number;
          rowIndex: number;
          amount: number;
          cashAccounts?: { cashAccount: string | null; amount: number }[];
        }[];
      }[];
    };

@Injectable()
export class SuggestService {
  constructor(
    @InjectRepository(Suggest)
    private readonly repo: Repository<Suggest>,

    @InjectRepository(SuggestHistory)
    private readonly historyRepo: Repository<SuggestHistory>,

    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectRepository(Policy)
    private readonly policyRepo: Repository<Policy>,

    @InjectRepository(SuggestReminderSetting)
    private readonly settingRepo: Repository<SuggestReminderSetting>,

    @InjectRepository(SuggestAttachment)
    private readonly attachmentRepo: Repository<SuggestAttachment>,

    private readonly eventEmitter: EventEmitter2,

    private readonly notificationService: NotificationService,
    private readonly suggestGateway: SuggestGateway,
    private readonly fcmService: FcmService,
    private readonly warehouseService: WarehouseService,
  ) {}

  private readonly logger = new Logger(SuggestService.name);

  // ================= CREATE =================

  async create(dto: CreateSuggestDto, fileUrl?: string, user?: Employee) {
    // Chi Năm gửi thẳng Giám đốc duyệt. Chi Ngoài / Chi Trường / Chi GV trường
    // (từ 16/11/2026) đi quy trình Kế toán — xem `createChainMonthlyExpense`.
    if (dto.type === SuggestType.EXPENSE_REQUEST) {
      const actor = this.ensureUser(user as AuthUser);

      if (!actor.roles?.some((role) => EXPENSE_REQUESTER_ROLES.includes(role))) {
        throw new ForbiddenException('Bạn không có quyền tạo đề nghị tài chính');
      }
      if (!dto.content) {
        throw new BadRequestException('Thiếu tiêu đề/nội dung đề xuất');
      }
      if (!dto.expectedPaymentDate) {
        throw new BadRequestException('Thiếu ngày dự kiến chi');
      }
      if (dto.expectedPaymentDate < vnToday()) {
        throw new BadRequestException(
          'Ngày dự kiến chi phải từ hôm nay trở đi',
        );
      }
      const isMonthlyExpense =
        dto.isMonthlyExpense === true ||
        dto.cashflowSource !== undefined ||
        dto.subjectId !== undefined ||
        dto.expensePeriodId !== undefined ||
        dto.monthlyItems !== undefined;
      // Từ 19/11/2026 form gửi các khoản đã tích (`cashflowItems`).
      if (dto.cashflowItems !== undefined) {
        return this.createSalesPickExpense(dto, fileUrl, actor);
      }
      if (isMonthlyExpense) {
        return this.createChainMonthlyExpense(dto, fileUrl, actor);
      }

      const hasSchool = dto.schoolId !== undefined && dto.schoolId !== null;
      // Năm học mặc định theo kỳ hiện tại để người tạo không cần tự chọn,
      // nhưng vẫn cho chọn năm khác — trường có thể chưa có môn học khai báo
      // cho năm hiện tại (chỉ có năm trước/sau), lúc đó phải tự đổi được.
      const schoolYear = hasSchool
        ? dto.schoolYear ?? currentSchoolYear()
        : null;
      if (hasSchool && schoolYear && !isValidSchoolYear(schoolYear)) {
        throw new BadRequestException('Năm học không hợp lệ');
      }
      if (!hasSchool && (dto.wardId === undefined || dto.wardId === null)) {
        throw new BadRequestException('Thiếu xã/phường');
      }

      const saved = await this.dataSource.transaction(async (manager) => {
        let school: School | undefined;
        let ward: Ward | undefined;
        let policySelections: PolicySupportSelection[] = [];

        if (hasSchool) {
          school = (await manager.findOne(School, {
            where: { id: dto.schoolId },
          })) ?? undefined;
          if (!school) {
            throw new BadRequestException('Trường không tồn tại');
          }

          const subjectCount = await manager.count(Subject, {
            where: {
              schoolId: dto.schoolId,
              schoolYear: schoolYear!,
            },
          });
          if (subjectCount === 0) {
            throw new BadRequestException(
              'Trường không có môn học trong năm học đã chọn',
            );
          }
          if (dto.deductPolicy !== false) {
            await this.assertPolicyHasSupport(manager, school, schoolYear!);
            policySelections = await this.resolvePolicySupportSelections(
              manager,
              school,
              schoolYear!,
              dto.policySupportItems,
              null,
            );
          }
        } else {
          ward = (await manager.findOne(Ward, {
            where: { id: dto.wardId },
          })) ?? undefined;
          if (!ward) {
            throw new BadRequestException('Xã/phường không tồn tại');
          }
        }

        const code = await this.generateCode(manager, 'suggest', 'code', 'DX');

        const initialStatus = SuggestStatus.PENDING_APPROVAL;
        const suggest = manager.create(Suggest, {
          type: SuggestType.EXPENSE_REQUEST,
          // Nhân viên không quyết định loại đề xuất. Để trống đến khi Giám
          // đốc/Sales Admin chốt CASH/EQUIPMENT/REPAIR lúc duyệt.
          requestKind: null,
          content: dto.content,
          description: dto.description,
          // Số tiền được xác định khi lập lệnh chi, không thuộc bước nhân
          // viên kinh doanh tạo đề xuất.
          amount: null,
          expectedPaymentDate: dto.expectedPaymentDate,
          beneficiaryInfo: dto.beneficiaryInfo ?? null,
          participants: dto.participants ?? null,
          // Chi Năm mặc định trừ chính sách. Khi kinh doanh chủ động bỏ chọn,
          // đề xuất không phụ thuộc hỗ trợ tiền mặt/thiết bị của chính sách.
          deductPolicy: dto.deductPolicy ?? true,
          ...(school ? { schoolId: school.id, school } : {}),
          isMonthlyExpense: false,
          cashflowSource: null,
          ...(schoolYear ? { schoolYear } : {}),
          ...(ward ? { wardId: ward.id, ward } : {}),
          fileUrl,
          code,
          version: 1,
          status: initialStatus,
          createdBy: actor.id,
        });

        const s = await manager.save(suggest);
        if (policySelections.length) {
          await this.savePolicySupportSelections(manager, s.id!, policySelections);
        }

        if (fileUrl) {
          await this.saveExpenseAttachments(
            manager,
            s.id!,
            [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
            actor.id,
            ExpenseAction.CREATE,
          );
        }

        await this.writeExpenseLog(manager, {
          suggestId: s.id!,
          userId: actor.id,
          action: ExpenseAction.CREATE,
          fromStatus: null,
          toStatus: initialStatus,
          details: {
            ...policySelectionLog(policySelections),
            ...(await this.expenseNextStepDetails(manager, s)),
          },
        });

        return s;
      });

      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title: '📋 Đề xuất mới chờ phân loại',
          message: `Có đề xuất mới cần duyệt và phân loại: ${saved.code} - ${saved.content}`,
          senderId: actor.id,
          meta: { status: saved.status },
        },
        { roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN] },
      );

      return this.findOneExpense(saved.id!);
    }

    let payload: SuggestCreatedEvent | null = null;
    console.log(user);
    let receiverIds: number[] = [];
    let tokens: string[] = [];
    let message = '';

    const saved = await this.dataSource.transaction(async (manager) => {
      let ward: Ward | null = null;
      if (dto.wardId !== undefined) {
        ward = await manager.findOne(Ward, {
          where: { id: dto.wardId },
          relations: ['province'],
        });
        if (!ward) throw new NotFoundException('Xã/phường không tồn tại');

        const globalRoles = [
          'director',
          'director_la',
          'saleadmin',
          'salesadmin_la',
        ];
        const canManageAll = user?.roles?.some((role) =>
          globalRoles.includes(role),
        );
        if (!canManageAll) {
          const assigned = await manager
            .createQueryBuilder(EmployeeRegion, 'er')
            .where('er.employeeId = :employeeId', { employeeId: user?.id })
            .andWhere('(er.wardId = :wardId OR er.provinceId = :provinceId)', {
              wardId: ward.id,
              provinceId: ward.province_id,
            })
            .getExists();
          if (!assigned) {
            throw new ForbiddenException(
              'Bạn không phụ trách xã/phường này',
            );
          }
        }

        if (dto.policyId) {
          const policy = await manager.findOne(Policy, {
            where: { id: dto.policyId },
            relations: ['subject', 'subject.school', 'subject.school.ward'],
          });
          if (!policy) throw new NotFoundException('Chính sách không tồn tại');
          if (policy.subject?.school?.ward?.id !== ward.id) {
            throw new BadRequestException(
              'Chính sách không thuộc xã/phường đã chọn',
            );
          }
        }
      }

      // Đề xuất thường không có số tiền. `amount` chỉ thuộc luồng
      // EXPENSE_REQUEST và được xử lý ở nhánh phía trên.
      const {
        amount: _amount,
        type: _type,
        expectedPaymentDate: _expectedPaymentDate,
        beneficiaryInfo: _beneficiaryInfo,
        participants: _participants,
        schoolId: _schoolId,
        isMonthlyExpense: _isMonthlyExpense,
        subjectId: _subjectId,
        expensePeriodId: _expensePeriodId,
        monthlyItems: _monthlyItems,
        schoolYear: _schoolYear,
        ...suggestionDto
      } = dto;
      const suggest = manager.create(Suggest, {
        ...suggestionDto,
        type: SuggestType.SUGGESTION,
        amount: null,
        fileUrl,
        version: 1,
        policyId: dto.policyId,
        wardId: ward?.id ?? null,
        ward,
        createdBy: user?.id,
        status: dto.status ?? SuggestStatus.PENDING,
      });

      const saved = await manager.save(suggest);

      // =================================================
      // GET RECEIVERS
      // =================================================

      const employees = await manager
        .createQueryBuilder(Employee, 'e')
        .where(`e.roles && ARRAY[:...roles]::text[]`, {
          roles: ['saleadmin', 'director', 'ketoan_congno', 'thuquy'],
        })
        .getMany();

      receiverIds = employees
        .map((e) => e.id)
        .filter((id): id is number => !!id);

      // =================================================
      // GET FCM TOKENS
      // =================================================

      const fcmTokens = await manager.find(EmployeeFcmToken, {
        where: {
          employeeId: In(receiverIds),
        },
      });

      tokens = fcmTokens.map((t) => t.token).filter(Boolean);

      message = `${user?.name} gửi một đề xuất mới: "${dto.content?.slice(0, 30)}"`;

      payload = new SuggestCreatedEvent(
        saved.id!,
        message,
        receiverIds,
        tokens,
        user?.id,
      );

      const { policy, ...clean } = saved;

      await manager.save(SuggestHistory, {
        suggestId: saved.id,
        data: clean,
      });

      return saved;
    });

    // =================================================
    // EMIT EVENT AFTER COMMIT
    // =================================================

    this.eventEmitter.emit('suggest.created', payload);

    const meta = {
      suggestId: saved.id,
      content: dto.content?.slice(0, 100),
    };

    // =================================================
    // CREATE DB NOTIFICATION
    // =================================================

    const notifications = await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: saved.id,
      message,
      senderId: user?.id,
      meta,
    });

    // =================================================
    // SOCKET REALTIME
    // =================================================

    notifications.forEach((noti) => {
      const socketPayload = {
        id: noti.id,
        type: noti.type,
        entityId: noti.entityId,
        message: noti.message,
        isRead: noti.isRead,
        createdAt: noti.createdAt,
        createdBy: user?.id,
        meta,
      };

      // notification realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('notification:new', socketPayload);

      // optional realtime suggest
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('suggest:new', {
          suggestId: saved.id,
          content: dto.content,
          createdBy: user?.id,
          createdAt: saved.createdAt,
        });
    });

    // =================================================
    // PUSH FCM
    // =================================================

    if (tokens.length > 0) {
      await this.fcmService.sendToMultiple(
        [...new Set(tokens)], // remove duplicate
        '💡 Đề xuất mới',
        message,
        {
          type: 'suggest',
          id: String(saved.id),
          url: `/director/suggest/${saved.id}`,
        },
      );
    }

    return saved;
  }
  // ======== QUY TRÌNH KẾ TOÁN: Chi Ngoài / Chi Trường / Chi GV trường ========
  // Từ 16/11/2026: kinh doanh tạo đề xuất cho một trường + một kỳ kế toán (chọn
  // kỳ đã có hoặc tạo kỳ tháng mới) → Kế toán nhập số liệu bảng ở QL thu chi rồi
  // gửi (chốt số tiền = Còn chi) → Kế toán trưởng duyệt → Giám đốc duyệt → Kế
  // toán công nợ lập lệnh chi → Thủ quỹ xuất tiền → kinh doanh nhận và chi.

  /**
   * Chi Năm cho trường: chính sách đã duyệt của trường trong năm học phải có
   * hỗ trợ tiền mặt hoặc thiết bị.
   */
  private async assertPolicyHasSupport(
    manager: EntityManager,
    school: School,
    schoolYear: string,
  ) {
    const support = await loadPolicySupport(manager, school.id!, schoolYear);
    if (!support.hasCash && !support.hasEquipment) {
      throw new BadRequestException(
        `Chính sách đã duyệt của ${school.name ?? 'trường'} năm học ${schoolYear} ` +
          'không có hỗ trợ tiền mặt hoặc thiết bị nên không tạo được đề xuất chi Năm',
      );
    }
  }

  /** Bảng hỗ trợ tiền mặt / thiết bị cho màn tạo và màn chi tiết đề xuất chi Năm. */
  async getPolicySupport(
    user: AuthUser,
    query: { schoolId: number; schoolYear: string; excludeSuggestId?: number },
  ) {
    const actor = this.ensureUser(user);
    const manager = this.dataSource.manager;
    if (this.isRequesterOnly(actor)) {
      const allowed = await actorSchoolIds(manager, actor.id);
      if (!allowed.includes(query.schoolId)) {
        throw new ForbiddenException('Trường không thuộc trường bạn phụ trách');
      }
    }
    // Đang sửa đề xuất của chính mình: phần của đề xuất đó không tính là đang giữ.
    let excludeSuggestId: number | null = null;
    if (query.excludeSuggestId) {
      const own = await this.repo.findOne({
        where: { id: query.excludeSuggestId, createdBy: actor.id },
        select: { id: true },
      });
      excludeSuggestId = own?.id ?? null;
    }
    return loadPolicySupport(manager, query.schoolId, query.schoolYear, excludeSuggestId);
  }

  /**
   * Kiểm các dòng hỗ trợ kinh doanh tích ở Đề xuất chi Năm cho trường: dòng có
   * trong chính sách đã duyệt của trường + năm học, không trùng, số tiền > 0 và
   * không vượt phần còn lại (Thành tiền thực tế / Thành tiền − đã chi − đang đề
   * xuất ở đề xuất khác). Khoá theo chính sách đến hết transaction.
   */
  private async resolvePolicySupportSelections(
    manager: EntityManager,
    school: School,
    schoolYear: string,
    input: { policyId: number; supportType: string; itemIndex: number; amount: number }[] | undefined,
    excludeSuggestId: number | null,
  ): Promise<PolicySupportSelection[]> {
    const items = input ?? [];
    if (!items.length) {
      throw new BadRequestException(
        'Tích ít nhất một dòng hỗ trợ tiền mặt hoặc thiết bị trong chính sách và nhập số tiền',
      );
    }
    for (const policyId of [...new Set(items.map((item) => Number(item.policyId)))].sort((a, b) => a - b)) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`policy-support:${policyId}`]);
    }
    const support = await loadPolicySupport(manager, school.id!, schoolYear, excludeSuggestId);
    const rows = new Map<string, { row: PolicySupportUsage; type: 'CASH' | 'EQUIPMENT'; policyId: number; subjectId: number; subjectName: string | null; label: string }>();
    for (const row of support.cash) {
      rows.set(row.rowKey, {
        row,
        type: 'CASH',
        policyId: row.policyId,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        label: `Tiền mặt · ${row.type ?? 'Hỗ trợ'}`,
      });
    }
    for (const row of support.equipment) {
      rows.set(row.rowKey, {
        row,
        type: 'EQUIPMENT',
        policyId: row.policyId,
        subjectId: row.subjectId,
        subjectName: row.subjectName,
        label: `Thiết bị · ${row.category ?? 'Thiết bị'}`,
      });
    }
    const seen = new Set<string>();
    return items.map((item) => {
      const type = item.supportType === 'EQUIPMENT' ? 'EQUIPMENT' : 'CASH';
      const key = policySupportRowKey(Number(item.policyId), type, Number(item.itemIndex));
      if (seen.has(key)) throw new BadRequestException('Tích trùng một dòng chính sách');
      seen.add(key);
      const found = rows.get(key);
      if (!found) {
        throw new BadRequestException(
          `Dòng chính sách đã chọn không còn trong chính sách đã duyệt của ${school.name ?? 'trường'} năm học ${schoolYear} — tải lại và chọn lại`,
        );
      }
      const amount = Math.round(Number(item.amount) * 100) / 100;
      if (!(amount > 0)) {
        throw new BadRequestException(`${found.subjectName ?? ''} · ${found.label}: số tiền phải lớn hơn 0`);
      }
      if (amount > found.row.remainingAmount + 0.005) {
        throw new BadRequestException(
          `${found.subjectName ?? ''} · ${found.label}: tối đa ${formatMoneyVnd(found.row.remainingAmount)} ` +
            `(chính sách ${formatMoneyVnd(found.row.capAmount)}, đã chi ${formatMoneyVnd(found.row.spentAmount)}, ` +
            `đang đề xuất ${formatMoneyVnd(found.row.heldAmount)})`,
        );
      }
      return {
        policyId: found.policyId,
        subjectId: found.subjectId,
        subjectName: found.subjectName,
        supportType: type,
        itemIndex: Number(item.itemIndex),
        label: found.label,
        policyAmount: found.row.capAmount,
        amount,
      };
    });
  }

  private async savePolicySupportSelections(
    manager: EntityManager,
    suggestId: number,
    selections: PolicySupportSelection[],
  ) {
    await manager.delete(SuggestPolicySupportItem, { suggestId });
    if (!selections.length) return;
    await manager.save(
      SuggestPolicySupportItem,
      selections.map((selection) =>
        manager.create(SuggestPolicySupportItem, { ...selection, suggestId, spentAmount: null }),
      ),
    );
  }

  private async storedPolicySupportInput(manager: EntityManager, suggestId: number) {
    const rows = await manager.find(SuggestPolicySupportItem, {
      where: { suggestId },
      order: { id: 'ASC' },
    });
    return rows.map((row) => ({
      policyId: row.policyId,
      supportType: row.supportType,
      itemIndex: row.itemIndex,
      amount: Number(row.amount),
    }));
  }

  /** Đề xuất chi Năm hoàn thành: Đã chi của từng dòng chính sách = đúng số kinh doanh nhập. */
  private async recordPolicySupportSpent(
    manager: EntityManager,
    suggestId: number,
  ): Promise<Record<string, unknown>> {
    const rows = await manager.find(SuggestPolicySupportItem, { where: { suggestId } });
    const pending = rows.filter((row) => row.spentAmount === null || row.spentAmount === undefined);
    if (!pending.length) return {};
    const now = new Date();
    for (const row of pending) {
      await manager.update(
        SuggestPolicySupportItem,
        { id: row.id },
        { spentAmount: Number(row.amount), spentAt: now },
      );
    }
    return {
      policySupportSpent: {
        total: Math.round(pending.reduce((sum, row) => sum + Number(row.amount), 0) * 100) / 100,
        items: pending.map((row) => ({
          label: [row.subjectName, row.label].filter(Boolean).join(' · '),
          amount: Number(row.amount),
        })),
      },
    };
  }

  /** Đề xuất quy trình Kế toán khác đang chạy cho cùng bảng (trường + kỳ + loại). */
  private async findOpenSheetRequest(
    manager: EntityManager,
    source: CashflowSource,
    schoolId: number,
    periodId: number,
    excludeSuggestId: number | null,
  ): Promise<{ id: number; code: string | null } | null> {
    const rows = await manager.query<{ id: number; code: string | null }[]>(
      `SELECT id, code FROM suggest
       WHERE type = 'EXPENSE_REQUEST' AND is_monthly_expense = true
         AND approval_flow = $1
         AND COALESCE(cashflow_source, 'MANAGEMENT') = $2
         AND school_id = $3 AND expense_period_id = $4
         AND status::text <> ALL($5)
         AND ($6::int IS NULL OR id <> $6)
       ORDER BY id LIMIT 1`,
      [
        ACCOUNTANT_CHAIN,
        source,
        schoolId,
        periodId,
        CASHFLOW_RELEASED_STATUSES,
        excludeSuggestId,
      ],
    );
    return rows[0] ? { id: Number(rows[0].id), code: rows[0].code } : null;
  }

  /**
   * Kiểm trường + kỳ của đề xuất quy trình Kế toán (tạo / sửa): trường thuộc
   * trường mình phụ trách, kỳ kế toán (Kế toán đã tạo) thuộc trường, chưa có
   * đề xuất khác đang chạy cho cùng bảng, và bảng đã có số liệu thì phải còn
   * khoản đề xuất được (Chi Trường: dòng "Có trong HĐ" tính đã chi).
   */
  private async resolveChainSheet(
    manager: EntityManager,
    actor: AuthUser,
    source: CashflowSource,
    input: {
      schoolId?: number | null;
      expensePeriodId?: number | null;
      schoolYear?: string | null;
    },
    excludeSuggestId: number | null,
  ): Promise<{ school: School; period: ExpensePeriod; schoolYear: string }> {
    if (!input.schoolId) {
      throw new BadRequestException('Chọn trường của đề xuất');
    }
    const school = await manager.findOne(School, {
      where: { id: input.schoolId },
    });
    if (!school) throw new BadRequestException('Trường không tồn tại');
    const allowed = await actorSchoolIds(manager, actor.id);
    if (!allowed.includes(school.id!)) {
      throw new ForbiddenException(
        `Trường ${school.name ?? `#${school.id}`} không thuộc trường bạn phụ trách`,
      );
    }

    if (!input.expensePeriodId) {
      throw new BadRequestException('Chọn kỳ kế toán của trường');
    }
    const period = await manager.findOne(ExpensePeriod, {
      where: { id: input.expensePeriodId },
      relations: ['school'],
    });
    if (!period) throw new BadRequestException('Kỳ kế toán không tồn tại');
    if (period.school?.id !== school.id) {
      throw new BadRequestException('Kỳ kế toán không thuộc trường đã chọn');
    }

    const schoolYear =
      input.schoolYear ?? schoolYearOfPeriod(period) ?? currentSchoolYear();
    if (!isValidSchoolYear(schoolYear)) {
      throw new BadRequestException('Năm học không hợp lệ');
    }

    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `suggest-cashflow-sheet:${source}:${school.id}:${period.id}`,
    ]);
    const open = await this.findOpenSheetRequest(
      manager,
      source,
      school.id!,
      period.id,
      excludeSuggestId,
    );
    const sheetLabel =
      `Bảng ${CASHFLOW_TABLE_LABELS[source]} của ${school.name ?? 'trường'} ` +
      periodLabelOf({ periodName: period.name, periodMonth: period.month, periodYear: period.year });
    if (open) {
      throw new BadRequestException(
        `${sheetLabel} đã có đề xuất ${open.code ?? `#${open.id}`} đang chạy`,
      );
    }
    // Bảng đã có số liệu mà không còn khoản nào đề xuất được thì không tạo.
    // Bảng chưa có số liệu vẫn tạo được (Kế toán nhập ở bước sau).
    const sheet = await this.sheetProposable(manager, source, school.id!, period.id, excludeSuggestId);
    if (sheet.hasData && !(sheet.proposableTotal > 0)) {
      throw new BadRequestException(
        `${sheetLabel} không còn khoản nào cần đề xuất` +
          (source === 'SCHOOL_EXPENSE'
            ? ' (chỉ dòng Hình thức chi "Không có trong HĐ" mới đề xuất được)'
            : ' (đã chi đủ hoặc đang nằm trong đề xuất khác)'),
      );
    }
    return { school, period, schoolYear };
  }

  /**
   * Số liệu bảng nguồn của trường trong kỳ: có số liệu chưa, tổng còn đề xuất
   * được (bỏ khoản đang nằm trong đề xuất khác chưa xong), phần "Có trong HĐ".
   */
  private async sheetProposable(
    manager: EntityManager,
    source: CashflowSource,
    schoolId: number,
    periodId: number,
    excludeSuggestId: number | null,
  ) {
    const { groups, unassigned } = await this.sheetGroups(manager, source, schoolId, periodId);
    const open = await loadOpenCashflowRequests(manager, source, [schoolId], excludeSuggestId);
    const held = new Map(open.map((request) => [request.key, request]));
    const round = (value: number) => Math.round(value * 100) / 100;
    return {
      groups,
      unassigned,
      held,
      hasData: groups.length > 0,
      proposableTotal: round(
        groups
          .filter((group) => !held.has(group.key))
          .reduce((sum, group) => sum + Math.max(0, group.remainingAmount), 0),
      ),
      inContractTotal: round(groups.reduce((sum, group) => sum + group.inContractAmount, 0)),
    };
  }

  /**
   * Màn tạo đề xuất Chi Ngoài / Chi Trường / Chi GV trường: toàn bộ số liệu Kế
   * toán đã nhập ở bảng nguồn của trường trong kỳ (từng dòng), kèm từng khoản
   * (Phải chi / Đã chi / Còn lại / trạng thái) và số còn đề xuất được.
   */
  async getCashflowSheet(
    user: AuthUser,
    query: { source: CashflowSource; schoolId: number; expensePeriodId: number; excludeSuggestId?: number },
  ) {
    const actor = this.ensureUser(user);
    const source = query.source;
    if (!isCashflowSource(source)) {
      throw new BadRequestException('Loại đề xuất chi tháng không hợp lệ');
    }
    const manager = this.dataSource.manager;
    const requesterOnly = this.isRequesterOnly(actor);
    if (requesterOnly) {
      const allowed = await actorSchoolIds(manager, actor.id);
      if (!allowed.includes(query.schoolId)) {
        throw new ForbiddenException('Trường không thuộc trường bạn phụ trách');
      }
    } else if (
      source === 'SCHOOL_TEACHER' &&
      !(actor.roles ?? []).some((role) =>
        [...(CASHFLOW_TEACHER_PAY_ROLES as readonly string[]), ...EXPENSE_REQUESTER_ROLES].includes(role),
      )
    ) {
      throw new ForbiddenException('Bạn không xem được lương giáo viên trường');
    }
    const period = await manager.findOne(ExpensePeriod, {
      where: { id: query.expensePeriodId },
      relations: ['school'],
    });
    if (!period || period.school?.id !== query.schoolId) {
      throw new BadRequestException('Kỳ kế toán không thuộc trường đã chọn');
    }
    // Sửa đề xuất của chính mình: khoản của đề xuất đó không tính là đang bị giữ.
    let excludeSuggestId: number | null = null;
    if (query.excludeSuggestId) {
      const own = await this.repo.findOne({
        where: { id: query.excludeSuggestId, createdBy: actor.id },
        select: { id: true },
      });
      excludeSuggestId = own?.id ?? null;
    }
    const sheet = await this.sheetProposable(
      manager,
      source,
      query.schoolId,
      query.expensePeriodId,
      excludeSuggestId,
    );
    const openSheet = await this.findOpenSheetRequest(
      manager,
      source,
      query.schoolId,
      query.expensePeriodId,
      excludeSuggestId,
    );
    const sections =
      source === 'MANAGEMENT'
        ? await this.loadSchoolManagementSections(
            query.schoolId,
            query.expensePeriodId,
            { schoolYear: null, subjectId: null },
            manager,
          )
        : [];
    const rows =
      source === 'MANAGEMENT'
        ? []
        : await loadSheetRows(manager, source, query.schoolId, query.expensePeriodId);
    // Chi trường / Chi Ban quản lí chỉ đề xuất được môn đã "Xác nhận đúng BBCS"
    // ở bảng Chi Ngoài.
    const bbcs =
      source === 'SCHOOL_TEACHER'
        ? null
        : await this.bbcsConfirmedKeys(manager, sheet.groups);
    return {
      source,
      table: CASHFLOW_TABLE_LABELS[source],
      school: { id: query.schoolId, name: period.school?.name ?? null },
      period: { id: period.id, month: period.month, year: period.year, name: period.name },
      hasData: sheet.hasData,
      proposableTotal: sheet.proposableTotal,
      inContractTotal: sheet.inContractTotal,
      openSheetRequest: openSheet,
      groups: sheet.groups.map((group) => {
        const holder = sheet.held.get(group.key) ?? null;
        return {
          ...group,
          label: cashflowGroupLabel(group),
          bbcsConfirmed: bbcs ? bbcs.has(group.key) : null,
          status: cashflowItemStatus(group, holder),
          openRequest: holder
            ? { id: holder.suggestId, code: holder.code, status: holder.status }
            : null,
        };
      }),
      sections,
      rows,
      unassigned: sheet.unassigned,
    };
  }

  /** Trường + kỳ của client cũ gửi danh sách khoản: chỉ nhận một trường, một kỳ. */
  private chainSheetInput(dto: {
    schoolId?: number | null;
    expensePeriodId?: number | null;
    monthlyItems?: MonthlyItemInput[];
  }) {
    if (!dto.monthlyItems?.length) {
      return { schoolId: dto.schoolId, expensePeriodId: dto.expensePeriodId };
    }
    const schools = new Set(dto.monthlyItems.map((item) => item.schoolId));
    const periods = new Set(dto.monthlyItems.map((item) => item.expensePeriodId));
    if (schools.size > 1) {
      throw new BadRequestException('Mỗi đề xuất chỉ cho một trường');
    }
    if (periods.size > 1) {
      throw new BadRequestException('Mỗi đề xuất chỉ cho một kỳ kế toán');
    }
    return {
      schoolId: dto.monthlyItems[0].schoolId,
      expensePeriodId: dto.monthlyItems[0].expensePeriodId,
    };
  }

  private async createChainMonthlyExpense(
    dto: CreateSuggestDto,
    fileUrl: string | undefined,
    actor: AuthUser,
  ) {
    const source: CashflowSource = dto.cashflowSource ?? 'MANAGEMENT';
    const sheetInput = this.chainSheetInput(dto);

    const saved = await this.dataSource.transaction(async (manager) => {
      const { school, period, schoolYear } = await this.resolveChainSheet(
        manager,
        actor,
        source,
        { ...sheetInput, schoolYear: dto.schoolYear },
        null,
      );

      const code = await this.generateCode(manager, 'suggest', 'code', 'DX');
      const initialStatus = SuggestStatus.PENDING_ACCOUNTANT;
      const s = await manager.save(
        manager.create(Suggest, {
          type: SuggestType.EXPENSE_REQUEST,
          requestKind: ExpenseRequestKind.CASH,
          content: dto.content,
          description: dto.description,
          // Số tiền chốt khi Kế toán gửi Kế toán trưởng (Còn chi của bảng).
          amount: null,
          expectedPaymentDate: dto.expectedPaymentDate,
          beneficiaryInfo: dto.beneficiaryInfo ?? null,
          participants: dto.participants ?? null,
          deductPolicy: dto.deductPolicy ?? false,
          schoolId: school.id,
          school,
          isMonthlyExpense: true,
          cashflowSource: source,
          approvalFlow: ACCOUNTANT_CHAIN,
          expensePeriodId: period.id,
          expensePeriod: period,
          schoolYear,
          fileUrl,
          code,
          version: 1,
          status: initialStatus,
          createdBy: actor.id,
        }),
      );

      if (fileUrl) {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
          actor.id,
          ExpenseAction.CREATE,
        );
      }

      await this.writeExpenseLog(manager, {
        suggestId: s.id!,
        userId: actor.id,
        action: ExpenseAction.CREATE,
        fromStatus: null,
        toStatus: initialStatus,
        details: {
          cashflowSource: source,
          sheet: {
            schoolId: school.id,
            schoolName: school.name ?? null,
            expensePeriodId: period.id,
            period: periodLabelOf({
              periodName: period.name,
              periodMonth: period.month,
              periodYear: period.year,
            }),
          },
          ...(await this.expenseNextStepDetails(manager, s)),
        },
      });
      return s;
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: `📋 ${this.monthlyKindLabel(saved)} chờ Kế toán nhập số liệu`,
        message:
          `${this.monthlyKindLabel(saved)} ${saved.code} - ${saved.content}: ` +
          'vui lòng nhập số liệu bảng ở QL thu chi rồi gửi Kế toán trưởng duyệt',
        senderId: actor.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT] },
    );

    return this.findOneExpense(saved.id!);
  }

  /** Khoản của bảng nguồn một trường trong một kỳ, như QL thu chi đang có. */
  private async sheetGroups(
    manager: EntityManager,
    source: CashflowSource,
    schoolId: number,
    periodId: number,
  ): Promise<{
    groups: CashflowGroup[];
    unassigned: Awaited<ReturnType<typeof loadSchoolTeacherGroups>>['unassigned'];
  }> {
    const filter = { schoolIds: [schoolId], periodIds: [periodId] };
    if (source === 'SCHOOL_EXPENSE') {
      return { groups: await loadSchoolExpenseGroups(manager, filter), unassigned: [] };
    }
    if (source === 'SCHOOL_TEACHER') {
      return loadSchoolTeacherGroups(manager, filter);
    }
    const sections = await this.loadSchoolManagementSections(
      schoolId,
      periodId,
      { schoolYear: null, subjectId: null },
      manager,
    );
    const periods = await this.loadPeriodInfo(manager, [periodId]);
    return { groups: managementGroupsFromSections(sections, periods), unassigned: [] };
  }

  /**
   * Kế toán gửi: chốt khoản + số tiền của đề xuất theo Còn chi hiện tại của
   * bảng. Đề xuất mới lấy mọi khoản còn phải chi của bảng (trường + kỳ); đề
   * xuất chuyển từ luồng cũ giữ các khoản kinh doanh đã chọn. Khoản đang nằm
   * trong đề xuất khác chưa xong thì bỏ qua (ghi vào lịch sử).
   */
  private async lockInChainItems(manager: EntityManager, s: Suggest) {
    const source = cashflowSourceOf(s) ?? 'MANAGEMENT';
    const table = CASHFLOW_TABLE_LABELS[source];
    const existing = await this.loadMonthlyRows(manager, s.id!);

    type Candidate = {
      ref: CashflowItemRef;
      schoolYear: string | null;
      label: string;
      remaining: number;
    };
    let candidates: Candidate[];
    if (existing.length) {
      const refs = existing.map((row) => this.cashflowRefOfRow(row));
      const groups = await this.cashflowGroupsFor(manager, source, refs);
      candidates = existing.map((row, index) => ({
        ref: refs[index],
        schoolYear: row.schoolYear ?? s.schoolYear ?? null,
        label: monthlyItemLabel(row),
        remaining: groups.get(cashflowItemKey(source, refs[index]))?.remainingAmount ?? 0,
      }));
    } else {
      if (!s.schoolId || !s.expensePeriodId) {
        throw new BadRequestException('Đề xuất thiếu trường hoặc kỳ kế toán');
      }
      const { groups, unassigned } = await this.sheetGroups(
        manager,
        source,
        s.schoolId,
        s.expensePeriodId,
      );
      if (unassigned.length) {
        const rows = unassigned.reduce((sum, item) => sum + item.rowCount, 0);
        const amount = unassigned.reduce((sum, item) => sum + item.amount, 0);
        throw new BadRequestException(
          `Bảng ${table} còn ${rows} dòng chưa chọn giáo viên (${formatMoneyVnd(amount)}) — ` +
            'chọn giáo viên ở QL thu chi trước khi gửi',
        );
      }
      candidates = groups.map((group) => ({
        ref: group,
        schoolYear: group.schoolYear ?? s.schoolYear ?? null,
        label: cashflowGroupLabel(group),
        remaining: group.remainingAmount,
      }));
    }

    const keys = candidates.map((c) => cashflowItemKey(source, c.ref));
    await lockCashflowKeys(manager, source, keys);
    const schoolIds = [
      ...new Set(
        candidates
          .map((c) => c.ref.schoolId)
          .filter((id): id is number => !!id),
      ),
    ];
    const open = await loadOpenCashflowRequests(manager, source, schoolIds, s.id!);
    const heldBy = new Map(open.map((request) => [request.key, request]));

    const chosen: Candidate[] = [];
    const skipped: { label: string; amount: number; code: string | null }[] = [];
    candidates.forEach((candidate, index) => {
      if (!(candidate.remaining > 0)) return;
      const holder = heldBy.get(keys[index]);
      if (holder) {
        skipped.push({
          label: candidate.label,
          amount: candidate.remaining,
          code: holder.code ?? `#${holder.suggestId}`,
        });
        return;
      }
      chosen.push(candidate);
    });
    if (!chosen.length) {
      throw new BadRequestException(
        skipped.length
          ? `Các khoản còn phải chi của bảng ${table} đang nằm trong đề xuất ` +
              `${[...new Set(skipped.map((item) => item.code))].join(', ')} chưa xong`
          : `Bảng ${table} của đề xuất chưa có khoản nào cần chi (Còn chi = 0) — ` +
              'nhập số liệu ở QL thu chi trước khi gửi',
      );
    }

    await manager.delete(SuggestMonthlyItem, { suggestId: s.id! });
    await manager.save(
      SuggestMonthlyItem,
      chosen.map((candidate, position) =>
        manager.create(SuggestMonthlyItem, {
          suggestId: s.id!,
          schoolId: candidate.ref.schoolId,
          schoolYear: candidate.schoolYear,
          subjectId: candidate.ref.subjectId ?? null,
          schoolTeacherId: candidate.ref.schoolTeacherId ?? null,
          expensePeriodId: candidate.ref.expensePeriodId,
          requestedAmount: candidate.remaining,
          position,
        }),
      ),
    );
    const total =
      Math.round(chosen.reduce((sum, c) => sum + c.remaining, 0) * 100) / 100;
    s.amount = total;
    await manager.update(Suggest, { id: s.id! }, { amount: total });
    return {
      cashflowSource: source,
      cashflowTable: table,
      amount: total,
      items: chosen.map((c) => ({ label: c.label, amount: c.remaining })),
      ...(skipped.length ? { skippedItems: skipped } : {}),
    };
  }

  async submitToChiefAccountant(id: number, user: AuthUser, note?: string) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Đề xuất chi không tồn tại');
    if (!isAccountantChain(existing)) {
      throw new BadRequestException('Đề xuất này không theo quy trình Kế toán');
    }
    const snapshot =
      cashflowSourceOf(existing) === 'MANAGEMENT'
        ? await this.managementExpenseSnapshot(existing)
        : {};
    let summary: Record<string, unknown> = {};
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.SUBMIT_TO_CHIEF_ACCOUNTANT,
      user,
      note: note?.trim() || undefined,
      extra: async (manager, s) => {
        summary = await this.lockInChainItems(manager, s);
      },
      logData: () => ({ ...summary, ...snapshot }),
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: `📋 ${this.monthlyKindLabel(saved)} chờ Kế toán trưởng duyệt`,
        message:
          `Kế toán đã nhập số liệu cho đề xuất ${saved.code} ` +
          `(${formatMoneyVnd(Number(saved.amount) || 0)}), vui lòng duyệt`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.CHIEF_ACCOUNTANT] },
    );
    return saved;
  }

  async chiefApproveExpense(id: number, user: AuthUser, note?: string) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Đề xuất chi không tồn tại');
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CHIEF_APPROVE,
      user,
      note: note?.trim() || undefined,
      extra: async (_manager, s) => {
        if (!isAccountantChain(s)) {
          throw new BadRequestException('Đề xuất này không theo quy trình Kế toán');
        }
      },
      logData: (_manager, s) => ({ amount: s.amount === null ? null : Number(s.amount) }),
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: `📋 ${this.monthlyKindLabel(saved)} chờ Giám đốc duyệt`,
        message:
          `Kế toán trưởng đã duyệt đề xuất ${saved.code} ` +
          `(${formatMoneyVnd(Number(saved.amount) || 0)}), vui lòng duyệt`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.DIRECTOR] },
    );
    return saved;
  }

  async chiefRejectExpense(id: number, user: AuthUser, reason: string) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Đề xuất chi không tồn tại');
    // Kế toán vừa gửi cũng cần biết đề xuất bị trả.
    const submitterId = await this.lastExpenseActorId(this.dataSource.manager, id);
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CHIEF_REJECT,
      user,
      note: reason,
      mutate: (s) => {
        s.rejectReason = reason;
      },
      extra: async (_manager, s) => {
        if (!isAccountantChain(s)) {
          throw new BadRequestException('Đề xuất này không theo quy trình Kế toán');
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '❌ Đề xuất chi bị từ chối',
        message: `Đề xuất ${saved.code} đã bị Kế toán trưởng từ chối: ${reason}`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        userIds: [saved.createdBy, submitterId].filter(
          (value): value is number => !!value,
        ),
      },
    );
    return saved;
  }

  /**
   * Giám đốc duyệt đề xuất quy trình Kế toán: số tiền đã chốt lúc Kế toán gửi;
   * bỏ tích khoản thì khoản đó không vào lệnh chi. Từ 20/11/2026 hệ thống tự
   * lập lệnh chi đúng số này (ghi tạm Tiền mặt, Thủ quỹ chọn nguồn khi xuất) —
   * bỏ bước Kế toán công nợ lập lệnh chi.
   */
  private async approveMonthlyChain(
    id: number,
    user: AuthUser,
    dto: ApproveExpenseDto,
  ) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Đề xuất chi không tồn tại');
    const snapshot = (await this.hasManagementItems(existing))
      ? await this.managementExpenseSnapshot(existing)
      : {};
    let decided: { id: number; label: string; amount: number; approved: boolean }[] = [];
    let total = 0;
    let paymentOrder: SuggestPaymentOrder | null = null;
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.APPROVE_MONTHLY_CHAIN,
      user,
      note: dto.note?.trim() || undefined,
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = null;
        s.requestKind = ExpenseRequestKind.CASH;
        if (dto.note !== undefined) s.approveNote = dto.note || null;
        // Lệnh chi mới: xoá dấu vết vòng chi trước (như khi Kế toán lập lệnh chi).
        s.cashReleasedBy = null;
        s.cashReleasedAt = null;
        s.cashReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.fundReturnedBy = null;
        s.fundReturnedAt = null;
      },
      extra: async (manager, s) => {
        const rows = await this.loadMonthlyRows(manager, s.id!);
        if (!rows.length) {
          throw new BadRequestException('Kế toán chưa gửi số liệu của đề xuất');
        }
        if (
          rows.some(
            (row) => row.requestedAmount === null || row.requestedAmount === undefined,
          )
        ) {
          throw new BadRequestException('Kế toán chưa nhập số tiền các khoản của đề xuất');
        }
        const amounts = rows.map((row) => Number(row.requestedAmount) || 0);
        const selection = selectApprovedItems(rows, amounts, dto.approvedItemIds);
        const excludedCount = rows.filter((row) => !selection.approvedIds.has(row.id)).length;
        if (excludedCount > 0 && !dto.note?.trim()) {
          throw new BadRequestException('Phải ghi lý do không duyệt các khoản bỏ chọn');
        }
        if (!(selection.total > 0)) {
          throw new BadRequestException('Các khoản được chọn không còn tiền cần chi nên không duyệt được');
        }
        total = selection.total;
        for (const [index, row] of rows.entries()) {
          const approved = selection.approvedIds.has(row.id);
          await manager.update(
            SuggestMonthlyItem,
            { id: row.id },
            {
              approvedAmount: approved ? amounts[index] : null,
              spent: null,
              excluded: !approved,
            },
          );
        }
        s.amount = total;
        await manager.update(Suggest, { id: s.id! }, { amount: total });
        decided = rows.map((row, index) => ({
          id: row.id,
          label: monthlyItemLabel(row),
          amount: amounts[index],
          approved: selection.approvedIds.has(row.id),
        }));
        // Lệnh chi tự lập = tổng Giám đốc duyệt; ghi tạm Tiền mặt, Thủ quỹ chọn
        // tài khoản xuất (một hoặc nhiều nguồn) thì đổi theo.
        const code = await this.generateCode(
          manager,
          'suggest_payment_order',
          'code',
          'LC',
        );
        await manager.delete(SuggestPaymentOrder, { suggestId: s.id! });
        paymentOrder = await manager.save(SuggestPaymentOrder, {
          code,
          suggestId: s.id!,
          amount: total,
          paymentMethod: PaymentMethod.CASH,
          note: null,
          createdBy: user.id,
        });
      },
      logData: () => ({
        requestKind: ExpenseRequestKind.CASH,
        amount: total,
        cashflowSource: isSalesPick(existing) ? null : cashflowSourceOf(existing),
        items: decided,
        // Sổ quỹ đọc snapshot này làm số tiền lệnh chi của lần xuất kế tiếp.
        paymentOrder: {
          code: (paymentOrder as SuggestPaymentOrder | null)?.code ?? null,
          amount: total,
          paymentMethod: PaymentMethod.CASH,
          auto: true,
        },
        ...snapshot,
      }),
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: `✅ ${this.monthlyKindLabel(saved)} đã duyệt`,
        message:
          `Đề xuất ${saved.code} đã được Giám đốc duyệt ${formatMoneyVnd(total)}, ` +
          `lệnh chi ${(paymentOrder as SuggestPaymentOrder | null)?.code ?? ''} đã tự lập — ` +
          'Thủ quỹ vui lòng xuất tiền và chọn nguồn tiền' +
          (decided.some((item) => !item.approved)
            ? `. Không duyệt: ${decided
                .filter((item) => !item.approved)
                .map((item) => item.label)
                .join('; ')}`
            : ''),
        senderId: user.id,
        meta: {
          status: saved.status,
          paymentOrderId: (paymentOrder as SuggestPaymentOrder | null)?.id,
        },
      },
      {
        roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );
    return saved;
  }

  /** Tổng phần Giám đốc đã duyệt của đề xuất quy trình Kế toán = số tiền lệnh chi. */
  private async chainApprovedTotal(manager: EntityManager, suggestId: number) {
    const rows = await manager.find(SuggestMonthlyItem, { where: { suggestId } });
    const approved = rows.filter(
      (row) => !row.excluded && row.approvedAmount !== null && row.approvedAmount !== undefined,
    );
    if (!approved.length) {
      throw new BadRequestException('Đề xuất chưa có số tiền Giám đốc duyệt');
    }
    return (
      Math.round(
        approved.reduce((sum, row) => sum + (Number(row.approvedAmount) || 0), 0) * 100,
      ) / 100
    );
  }

  // ======== "ĐỀ XUẤT CHI THÁNG" TÍCH CHỌN (19/11/2026) ========
  // Kinh doanh chọn một trường + một kỳ kế toán, tích Chi trường / Chi Ban quản
  // lí (chỉ môn đã xác nhận BBCS) / Chi giáo viên (bảng Giáo viên trường Kế toán
  // đã nhập), nhập một số tiền ≤ tổng Còn chi đã chọn → Kế toán / Kế toán công
  // nợ nhập số tiền từng khoản → Giám đốc → Kế toán công nợ lập lệnh chi → Thủ
  // quỹ → kinh doanh (Đã chi ghi về QL thu chi theo từng khoản).

  /**
   * Khoản (theo khoá `cashflowItemKey`) đã "Xác nhận đúng BBCS" ở bảng Chi
   * Ngoài: mọi bảng thu chi chứa khoản đều đã xác nhận môn đó.
   */
  private async bbcsConfirmedKeys(
    manager: EntityManager,
    groups: CashflowGroup[],
  ): Promise<Set<string>> {
    const confirmations = await loadManagementConfirmations(
      manager,
      groups.flatMap((group) => group.schoolExpenseIds),
    );
    const confirmed = new Set(
      confirmations.map((row) => `${row.schoolExpenseId}:${row.subjectId}`),
    );
    return new Set(
      groups
        .filter(
          (group) =>
            !!group.subjectId &&
            group.schoolExpenseIds.length > 0 &&
            group.schoolExpenseIds.every((sheetId) =>
              confirmed.has(`${sheetId}:${group.subjectId}`),
            ),
        )
        .map((group) => group.key),
    );
  }

  /** Trường + kỳ kế toán của đề xuất chi tháng: trường mình phụ trách, kỳ thuộc trường. */
  private async resolveSchoolPeriod(
    manager: EntityManager,
    actor: AuthUser,
    input: {
      schoolId?: number | null;
      expensePeriodId?: number | null;
      schoolYear?: string | null;
    },
  ): Promise<{ school: School; period: ExpensePeriod; schoolYear: string }> {
    if (!input.schoolId) {
      throw new BadRequestException('Chọn trường của đề xuất');
    }
    const school = await manager.findOne(School, {
      where: { id: input.schoolId },
    });
    if (!school) throw new BadRequestException('Trường không tồn tại');
    const allowed = await actorSchoolIds(manager, actor.id);
    if (!allowed.includes(school.id!)) {
      throw new ForbiddenException(
        `Trường ${school.name ?? `#${school.id}`} không thuộc trường bạn phụ trách`,
      );
    }
    if (!input.expensePeriodId) {
      throw new BadRequestException('Chọn kỳ kế toán của trường');
    }
    const period = await manager.findOne(ExpensePeriod, {
      where: { id: input.expensePeriodId },
      relations: ['school'],
    });
    if (!period) throw new BadRequestException('Kỳ kế toán không tồn tại');
    if (period.school?.id !== school.id) {
      throw new BadRequestException('Kỳ kế toán không thuộc trường đã chọn');
    }
    const schoolYear =
      input.schoolYear ?? schoolYearOfPeriod(period) ?? currentSchoolYear();
    if (!isValidSchoolYear(schoolYear)) {
      throw new BadRequestException('Năm học không hợp lệ');
    }
    return { school, period, schoolYear };
  }

  /**
   * Kiểm các khoản kinh doanh tích (tạo / sửa): khoản có trong bảng của trường
   * trong kỳ và còn tiền phải chi, không nằm trong đề xuất khác chưa xong, Chi
   * trường / Chi Ban quản lí phải là môn đã xác nhận BBCS, Chi giáo viên cần
   * bảng Giáo viên trường đã có số liệu; số tiền kinh doanh nhập > 0 và không
   * vượt tổng Còn chi các khoản đã chọn.
   */
  private async resolveSalesPick(
    manager: EntityManager,
    actor: AuthUser,
    input: {
      schoolId?: number | null;
      expensePeriodId?: number | null;
      schoolYear?: string | null;
      items?: MonthlyCashflowItemDto[];
      salesAmount?: number | null;
    },
    excludeSuggestId: number | null,
  ) {
    const { school, period, schoolYear } = await this.resolveSchoolPeriod(
      manager,
      actor,
      input,
    );
    const items = input.items ?? [];
    if (!items.length) {
      throw new BadRequestException(
        'Tích Chi trường / Chi Ban quản lí / Chi giáo viên và chọn ít nhất một khoản',
      );
    }
    const refs = items.map((item) => {
      if (!isCashflowSource(item.source)) {
        throw new BadRequestException('Loại khoản chi tháng không hợp lệ');
      }
      const ref: CashflowItemRef = {
        schoolId: school.id!,
        expensePeriodId: period.id,
        subjectId: item.source === 'SCHOOL_TEACHER' ? null : Number(item.subjectId) || null,
        schoolTeacherId:
          item.source === 'SCHOOL_TEACHER' ? Number(item.schoolTeacherId) || null : null,
      };
      if (item.source === 'SCHOOL_TEACHER' ? !ref.schoolTeacherId : !ref.subjectId) {
        throw new BadRequestException(
          item.source === 'SCHOOL_TEACHER'
            ? 'Khoản Chi giáo viên phải có giáo viên'
            : 'Khoản Chi trường / Chi Ban quản lí phải có môn',
        );
      }
      return { source: item.source, ref, key: cashflowItemKey(item.source, ref) };
    });
    const seen = new Set<string>();
    for (const ref of refs) {
      const id = `${ref.source}:${ref.key}`;
      if (seen.has(id)) throw new BadRequestException('Chọn trùng khoản');
      seen.add(id);
    }

    const periodLabel = periodLabelOf({
      periodName: period.name,
      periodMonth: period.month,
      periodYear: period.year,
    });
    const picks: {
      source: CashflowSource;
      ref: CashflowItemRef;
      schoolYear: string | null;
      label: string;
      remaining: number;
    }[] = [];
    const sources = [...new Set(refs.map((ref) => ref.source))].sort();
    for (const source of sources) {
      const table = CASHFLOW_TABLE_LABELS[source];
      const kind = SALES_PICK_SOURCE_LABELS[source];
      // Cùng khoá bảng với quy trình Kế toán cũ: không chạy song song với đơn
      // cũ đang giữ cả bảng.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `suggest-cashflow-sheet:${source}:${school.id}:${period.id}`,
      ]);
      const openSheet = await this.findOpenSheetRequest(
        manager,
        source,
        school.id!,
        period.id,
        excludeSuggestId,
      );
      if (openSheet) {
        throw new BadRequestException(
          `${kind}: bảng ${table} của ${school.name ?? 'trường'} ${periodLabel} đang có đề xuất ` +
            `${openSheet.code ?? `#${openSheet.id}`} (quy trình Kế toán cũ) chưa xong`,
        );
      }
      const own = refs.filter((ref) => ref.source === source);
      await lockCashflowKeys(manager, source, own.map((ref) => ref.key));
      const { groups } = await this.sheetGroups(manager, source, school.id!, period.id);
      if (source === 'SCHOOL_TEACHER' && !groups.length) {
        throw new BadRequestException(
          `Kế toán chưa nhập bảng Giáo viên trường của ${school.name ?? 'trường'} ${periodLabel} ` +
            '(hoặc dòng chưa chọn giáo viên) nên chưa đề xuất Chi giáo viên được',
        );
      }
      const byKey = new Map(groups.map((group) => [group.key, group]));
      const held = new Map(
        (
          await loadOpenCashflowRequests(manager, source, [school.id!], excludeSuggestId)
        ).map((request) => [request.key, request]),
      );
      const confirmed =
        source === 'SCHOOL_TEACHER'
          ? null
          : await this.bbcsConfirmedKeys(manager, groups);
      for (const ref of own) {
        const group = byKey.get(ref.key);
        if (!group) {
          throw new BadRequestException(
            `${kind}: khoản đã chọn không có trong bảng ${table} của kỳ này — tải lại trang`,
          );
        }
        const label = `${kind} · ${cashflowGroupLabel(group)}`;
        const holder = held.get(ref.key);
        if (holder) {
          throw new BadRequestException(
            `${label} đang nằm trong đề xuất ${holder.code ?? `#${holder.suggestId}`} chưa xong`,
          );
        }
        if (confirmed && !confirmed.has(ref.key)) {
          throw new BadRequestException(
            `${label}: bảng Chi Ngoài của môn chưa "Xác nhận đúng BBCS" nên chưa đề xuất được`,
          );
        }
        if (!(group.remainingAmount > 0)) {
          throw new BadRequestException(
            source === 'SCHOOL_EXPENSE' && group.unsetPaymentTypeAmount > 0
              ? `${label}: chỉ đề xuất được dòng Chi Trường có Hình thức chi "Không có trong HĐ"`
              : `${label} không còn tiền phải chi`,
          );
        }
        picks.push({
          source,
          ref: ref.ref,
          schoolYear: group.schoolYear ?? schoolYear,
          label,
          remaining: group.remainingAmount,
        });
      }
    }
    // Giữ đúng thứ tự kinh doanh tích.
    const order = new Map(refs.map((ref, index) => [`${ref.source}:${ref.key}`, index]));
    picks.sort(
      (a, b) =>
        (order.get(`${a.source}:${cashflowItemKey(a.source, a.ref)}`) ?? 0) -
        (order.get(`${b.source}:${cashflowItemKey(b.source, b.ref)}`) ?? 0),
    );
    const total = round2(picks.reduce((sum, pick) => sum + pick.remaining, 0));
    const salesAmount = round2(Number(input.salesAmount) || 0);
    if (!(salesAmount > 0)) {
      throw new BadRequestException('Nhập số tiền đề xuất');
    }
    if (salesAmount > total + 0.005) {
      throw new BadRequestException(
        `Số tiền đề xuất (${formatMoneyVnd(salesAmount)} đ) vượt tổng Còn chi các khoản đã chọn ` +
          `(${formatMoneyVnd(total)} đ)`,
      );
    }
    return { school, period, schoolYear, picks, total, salesAmount };
  }

  /** Lưu khoản của "Đề xuất chi tháng" tích chọn (số tiền từng khoản do Kế toán nhập sau). */
  private async saveSalesPickItems(
    manager: EntityManager,
    suggestId: number,
    picks: Awaited<ReturnType<SuggestService['resolveSalesPick']>>['picks'],
  ) {
    await manager.delete(SuggestMonthlyItem, { suggestId });
    await manager.save(
      SuggestMonthlyItem,
      picks.map((pick, position) =>
        manager.create(SuggestMonthlyItem, {
          suggestId,
          cashflowSource: pick.source,
          schoolId: pick.ref.schoolId,
          schoolYear: pick.schoolYear,
          subjectId: pick.ref.subjectId ?? null,
          schoolTeacherId: pick.ref.schoolTeacherId ?? null,
          expensePeriodId: pick.ref.expensePeriodId,
          requestedAmount: null,
          position,
        }),
      ),
    );
  }

  private salesPickLog(
    resolved: Awaited<ReturnType<SuggestService['resolveSalesPick']>>,
  ) {
    return {
      sheet: {
        schoolId: resolved.school.id,
        schoolName: resolved.school.name ?? null,
        expensePeriodId: resolved.period.id,
        period: periodLabelOf({
          periodName: resolved.period.name,
          periodMonth: resolved.period.month,
          periodYear: resolved.period.year,
        }),
      },
      salesAmount: resolved.salesAmount,
      remainingTotal: resolved.total,
      pickedItems: resolved.picks.map((pick) => ({
        source: pick.source,
        label: pick.label,
        remaining: pick.remaining,
      })),
    };
  }

  private async createSalesPickExpense(
    dto: CreateSuggestDto,
    fileUrl: string | undefined,
    actor: AuthUser,
  ) {
    const saved = await this.dataSource.transaction(async (manager) => {
      const resolved = await this.resolveSalesPick(
        manager,
        actor,
        {
          schoolId: dto.schoolId,
          expensePeriodId: dto.expensePeriodId,
          schoolYear: dto.schoolYear,
          items: dto.cashflowItems,
          salesAmount: dto.salesAmount,
        },
        null,
      );
      const { school, period, schoolYear, picks } = resolved;

      const code = await this.generateCode(manager, 'suggest', 'code', 'DX');
      const initialStatus = SuggestStatus.PENDING_ACCOUNTANT;
      const s = await manager.save(
        manager.create(Suggest, {
          type: SuggestType.EXPENSE_REQUEST,
          requestKind: ExpenseRequestKind.CASH,
          content: dto.content,
          description: dto.description,
          // Tổng số tiền Kế toán nhập từng khoản (lúc gửi Giám đốc).
          amount: null,
          salesAmount: resolved.salesAmount,
          expectedPaymentDate: dto.expectedPaymentDate,
          beneficiaryInfo: dto.beneficiaryInfo ?? null,
          participants: dto.participants ?? null,
          deductPolicy: dto.deductPolicy ?? false,
          schoolId: school.id,
          school,
          isMonthlyExpense: true,
          // Cột cũ chỉ nhận một bảng: lấy bảng của khoản đầu; bảng từng khoản ở
          // `suggest_monthly_items.cashflow_source`.
          cashflowSource: picks[0].source,
          approvalFlow: SALES_PICK,
          expensePeriodId: period.id,
          expensePeriod: period,
          schoolYear,
          fileUrl,
          code,
          version: 1,
          status: initialStatus,
          createdBy: actor.id,
        }),
      );
      await this.saveSalesPickItems(manager, s.id!, picks);

      if (fileUrl) {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
          actor.id,
          ExpenseAction.CREATE,
        );
      }

      await this.writeExpenseLog(manager, {
        suggestId: s.id!,
        userId: actor.id,
        action: ExpenseAction.CREATE,
        fromStatus: null,
        toStatus: initialStatus,
        details: {
          ...this.salesPickLog(resolved),
          ...(await this.expenseNextStepDetails(manager, s)),
        },
      });
      return s;
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📋 Đề xuất chi tháng chờ Kế toán nhập số tiền',
        message:
          `Đề xuất chi tháng ${saved.code} - ${saved.content} ` +
          `(${formatMoneyVnd(Number(saved.salesAmount) || 0)} đ): ` +
          'vui lòng nhập số tiền từng khoản rồi gửi Giám đốc duyệt',
        senderId: actor.id,
        meta: { status: saved.status },
      },
      {
        roles: [
          ExpenseRole.ACCOUNTANT,
          ExpenseRole.DEBT_ACCOUNTANT,
          ExpenseRole.CHIEF_ACCOUNTANT,
        ],
      },
    );

    return this.findOneExpense(saved.id!);
  }

  /** Còn phải chi hiện tại của từng khoản (theo bảng nguồn của từng khoản). */
  private async salesPickRemaining(
    manager: EntityManager,
    s: Suggest,
    rows: SuggestMonthlyItem[],
  ): Promise<number[]> {
    const result = rows.map(() => 0);
    for (const source of CASHFLOW_SOURCES) {
      const indexes = rows
        .map((row, index) => (itemSourceOf(row, s) === source ? index : -1))
        .filter((index) => index >= 0);
      if (!indexes.length) continue;
      const refs = indexes.map((index) => this.cashflowRefOfRow(rows[index]));
      const groups = await this.cashflowGroupsFor(manager, source, refs);
      indexes.forEach((rowIndex, i) => {
        result[rowIndex] = Math.max(
          0,
          groups.get(cashflowItemKey(source, refs[i]))?.remainingAmount ?? 0,
        );
      });
    }
    return result;
  }

  /**
   * Kế toán / Kế toán công nợ nhập số tiền từng khoản kinh doanh đã chọn rồi
   * gửi thẳng Giám đốc: mỗi khoản ≤ Còn chi hiện tại, tổng > 0 và ≤ số kinh
   * doanh đề xuất. Khoản nhập 0 bị bỏ khỏi đề xuất (khoản được đề xuất lại).
   */
  async submitMonthlyAmounts(
    id: number,
    user: AuthUser,
    amounts: { id: number; amount: number }[],
    note?: string,
  ) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Đề xuất chi không tồn tại');
    if (!isSalesPick(existing)) {
      throw new BadRequestException(
        'Đề xuất này không phải Đề xuất chi tháng tích chọn khoản',
      );
    }
    let summary: Record<string, unknown> = {};
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.SUBMIT_MONTHLY_AMOUNTS,
      user,
      note: note?.trim() || undefined,
      extra: async (manager, s) => {
        const rows = await this.loadMonthlyRows(manager, s.id!);
        if (!rows.length) {
          throw new BadRequestException('Đề xuất không có khoản nào');
        }
        const input = new Map<number, number>();
        for (const item of amounts ?? []) {
          if (input.has(Number(item.id))) {
            throw new BadRequestException('Nhập trùng khoản');
          }
          input.set(Number(item.id), round2(Number(item.amount)));
        }
        if (
          input.size !== rows.length ||
          rows.some((row) => !input.has(row.id))
        ) {
          throw new BadRequestException(
            'Nhập số tiền cho đủ các khoản của đề xuất (tải lại trang nếu đề xuất vừa đổi)',
          );
        }
        const remaining = await this.salesPickRemaining(manager, s, rows);
        const decided = rows.map((row, index) => {
          const amount = input.get(row.id)!;
          const label = monthlyItemLabel(row);
          if (!Number.isFinite(amount) || amount < 0) {
            throw new BadRequestException(`${label}: số tiền không hợp lệ`);
          }
          if (amount > remaining[index] + 0.005) {
            throw new BadRequestException(
              `${label}: ${formatMoneyVnd(amount)} đ vượt Còn chi ` +
                `(${formatMoneyVnd(remaining[index])} đ)`,
            );
          }
          return { row, label, amount, remaining: remaining[index] };
        });
        const total = round2(decided.reduce((sum, item) => sum + item.amount, 0));
        if (!(total > 0)) {
          throw new BadRequestException('Nhập số tiền cho ít nhất một khoản');
        }
        const salesAmount = Number(s.salesAmount) || 0;
        if (salesAmount > 0 && total > salesAmount + 0.005) {
          throw new BadRequestException(
            `Tổng số tiền các khoản (${formatMoneyVnd(total)} đ) vượt số kinh doanh đề xuất ` +
              `(${formatMoneyVnd(salesAmount)} đ)`,
          );
        }
        const dropped = decided.filter((item) => !(item.amount > 0));
        if (dropped.length) {
          await manager.delete(SuggestMonthlyItem, {
            id: In(dropped.map((item) => item.row.id)),
          });
        }
        for (const item of decided) {
          if (!(item.amount > 0)) continue;
          await manager.update(
            SuggestMonthlyItem,
            { id: item.row.id },
            { requestedAmount: item.amount, approvedAmount: null, excluded: false, spent: null },
          );
        }
        s.amount = total;
        await manager.update(Suggest, { id: s.id! }, { amount: total });
        summary = {
          salesAmount,
          amount: total,
          items: decided
            .filter((item) => item.amount > 0)
            .map((item) => ({
              id: item.row.id,
              source: itemSourceOf(item.row, s),
              label: item.label,
              amount: item.amount,
              remaining: item.remaining,
            })),
          ...(dropped.length
            ? {
                droppedItems: dropped.map((item) => ({
                  label: item.label,
                  remaining: item.remaining,
                })),
              }
            : {}),
        };
      },
      logData: () => summary,
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📋 Đề xuất chi tháng chờ Giám đốc duyệt',
        message:
          `Kế toán đã nhập số tiền cho đề xuất ${saved.code} ` +
          `(${formatMoneyVnd(Number(saved.amount) || 0)} đ), vui lòng duyệt`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.DIRECTOR] },
    );
    return saved;
  }

  // ================= UPDATE =================

  async update(
    id: number,
    dto: CreateSuggestDto,
    fileUrl?: string,
    user?: Employee,
  ) {
    let receiverIds: number[] = [];
    let tokens: string[] = [];
    let message = '';

    const saved = await this.dataSource.transaction(async (manager) => {
      const existing = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!existing) {
        throw new NotFoundException('Suggest not found');
      }

      // =================================================
      // SAVE HISTORY
      // =================================================

      const snapshot = { ...existing };

      await manager.save(SuggestHistory, {
        suggestId: existing.id,
        data: snapshot,
        createdBy: user?.id,
      });

      // =================================================
      // UPDATE DATA
      // =================================================

      const {
        policyId,
        status,
        amount: _amount,
        type: _type,
        expectedPaymentDate: _expectedPaymentDate,
        beneficiaryInfo: _beneficiaryInfo,
        participants: _participants,
        schoolId: _schoolId,
        isMonthlyExpense: _isMonthlyExpense,
        subjectId: _subjectId,
        expensePeriodId: _expensePeriodId,
        monthlyItems: _monthlyItems,
        schoolYear: _schoolYear,
        ...rest
      } = dto;

      Object.assign(existing, rest);
      if (existing.type === SuggestType.SUGGESTION) {
        existing.amount = null;
      }

      if (fileUrl) {
        existing.fileUrl = fileUrl;
      }

      if (status !== undefined) {
        existing.status = status;
      }

      // =================================================
      // POLICY
      // =================================================

      if (policyId !== undefined) {
        if (policyId === null) {
          existing.policyId = null;
        } else {
          const policy = await manager.findOne(Policy, {
            where: {
              id: policyId,
            },
          });

          if (!policy) {
            throw new NotFoundException('Policy không tồn tại');
          }

          existing.policyId = policy.id;
        }
      }

      // =================================================
      // VERSION
      // =================================================

      existing.version = (existing.version ?? 1) + 1;

      const updated = await manager.save(existing);

      // =================================================
      // GET RECEIVERS
      // =================================================

      const employees = await manager
        .createQueryBuilder(Employee, 'e')
        .where(`e.roles && ARRAY[:...roles]::text[]`, {
          roles: ['saleadmin', 'director'],
        })
        .getMany();

      receiverIds = employees
        .map((e) => e.id)
        .filter((id): id is number => !!id);

      // =================================================
      // GET TOKENS
      // =================================================

      const fcmTokens = await manager.find(EmployeeFcmToken, {
        where: {
          employeeId: In(receiverIds),
        },
      });

      tokens = [...new Set(fcmTokens.map((t) => t.token).filter(Boolean))];

      const name = fixVietnamese(user?.name || '');

      message = `${name} đã cập nhật đề xuất #${updated.id}`;

      return updated;
    });

    // =================================================
    // META
    // =================================================

    const meta = {
      suggestId: saved.id,
      content: saved.content?.slice(0, 100),
    };

    // =================================================
    // CREATE DB NOTIFICATION
    // =================================================

    const notifications = await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: saved.id,
      message,
      senderId: user?.id,
      meta,
    });

    // =================================================
    // SOCKET REALTIME
    // =================================================

    notifications.forEach((noti) => {
      const socketPayload = {
        id: noti.id,
        type: noti.type,
        entityId: noti.entityId,
        message: noti.message,
        isRead: noti.isRead,
        createdAt: noti.createdAt,
        createdBy: user?.id,
        meta,
      };

      // notification realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('notification:new', socketPayload);

      // suggest updated realtime
      this.suggestGateway.server
        .to(`user_${noti.receiverId}`)
        .emit('suggest:updated', {
          suggestId: saved.id,
          content: saved.content,
          status: saved.status,
          updatedBy: user?.id,
          updatedAt: saved.updatedAt,
        });
    });

    // =================================================
    // PUSH FCM
    // =================================================

    if (tokens.length > 0) {
      await this.fcmService.sendToMultiple(
        tokens,
        '📝 Đề xuất cập nhật',
        message,
        {
          type: 'suggest_update',
          id: String(saved.id),
          url: `/director/suggest/${saved.id}`,
        },
      );
    }

    return saved;
  }

  // ================= GET =================

  async findAll() {
    return this.repo.find({
      where: { type: SuggestType.SUGGESTION },
      relations: ['ward', 'policy'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: number) {
    const suggest = await this.repo.findOne({
      where: { id },
      relations: {
        ward: true,
        policy: {
          subject: {
            school: true,
          },
        },
      },
    });

    if (!suggest) {
      throw new NotFoundException('Suggest not found');
    }

    return suggest;
  }

  async findHistory(suggestId: number) {
    return this.historyRepo.find({
      where: { suggestId },
      relations: ['policy'],
      order: { snapshotAt: 'DESC' },
    });
  }

  // ================= DELETE (optional) =================

  async remove(id: number, user?: Employee) {
    const suggest = await this.repo.findOne({
      where: { id },
    });

    if (!suggest) {
      throw new NotFoundException('Suggest not found');
    }

    // 🔒 chỉ cho xoá khi PENDING
    if (suggest.status !== 'PENDING') {
      throw new BadRequestException('Chỉ được xoá khi đang chờ');
    }

    // 🔒 chỉ chủ sở hữu được xoá
    if (suggest.createdBy !== user?.id) {
      throw new ForbiddenException('Không có quyền xoá');
    }

    await this.repo.remove(suggest);

    return { message: 'Deleted successfully' };
  }

  async reviewBySaleAdmin(
    id: number,
    status: SuggestStatus,
    user: Employee,
    rejectReason?: string,
  ) {
    let payload: SuggestReviewedEvent | null = null;

    if (!user) {
      throw new UnauthorizedException('User không hợp lệ');
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!suggest) {
        throw new NotFoundException('Suggest not found');
      }
      if (suggest.status === SuggestStatus.APPROVED) {
        throw new BadRequestException(
          'Đã được director duyệt, không cần saleadmin xử lý',
        );
      }
      // 🔒 role
      if (
        !user.roles?.some((r: string) =>
          [
            'saleadmin',
            'salesadmin_la',
            'ketoan_truong',
            'troly_gd',
            'director',
            'director_la',
          ].includes(r),
        )
      ) {
        throw new ForbiddenException('Không có quyền xử lý đề xuất');
      }

      // 🔒 status hợp lệ
      if (![SuggestStatus.REVIEWED, SuggestStatus.REJECTED].includes(status)) {
        throw new BadRequestException('Chỉ được REVIEWED hoặc REJECTED');
      }

      // 🔒 chỉ xử lý khi PENDING
      if (suggest.status !== SuggestStatus.PENDING) {
        throw new BadRequestException('Chỉ xử lý khi PENDING');
      }

      // 📸 history
      await manager.save(SuggestHistory, {
        suggestId: suggest.id,
        data: { ...suggest },
        createdBy: user.id,
      });

      // 🔥 update
      suggest.status = status;
      suggest.reviewedBy = user.id;

      if (status === SuggestStatus.REJECTED) {
        if (!rejectReason) {
          throw new BadRequestException('Phải có lý do từ chối');
        }
        suggest.rejectReason = rejectReason;
      } else {
        suggest.rejectReason = null;
      }

      const saved = await manager.save(suggest);

      // Đây chỉ là bước kiểm duyệt TRUNG GIAN — giám đốc vẫn cần tự thấy
      // "cần duyệt" để quyết định cuối, nên CHỈ đánh dấu đã đọc cho đúng
      // người vừa kiểm duyệt, không đụng tới thông báo của người khác.
      await this.notificationService.markAsReadByTypeEntityForReceiver(
        NotificationType.SUGGEST,
        suggest.id!,
        user.id!,
      );

      // ================= NOTIFY =================

      // 👤 người tạo
      const creator = await manager.findOne(Employee, {
        where: {
          id: suggest.createdBy,
        },

        select: {
          id: true,
        },
      });

      const creatorId = creator?.id;

      // 👨‍💼 director
      const directors = await manager
        .createQueryBuilder(Employee, 'e')
        .select(['e.id'])
        .where(`'director' = ANY(e.roles)`)
        .getMany();

      const directorIds = directors
        .map((d) => d.id)
        .filter((id): id is number => !!id);

      const reviewedReceiverIds = [
        ...(creatorId ? [creatorId] : []),
        ...directorIds,
      ];

      // 📱 lấy hết token của mọi thiết bị (không chỉ 1 token/người)
      const reviewedFcmTokens = await manager.find(EmployeeFcmToken, {
        where: { employeeId: In(reviewedReceiverIds) },
      });
      const reviewedTokens = reviewedFcmTokens.map((t) => t.token).filter(Boolean);

      let message = '';
      if (status === SuggestStatus.REVIEWED) {
        message = `${user?.name} đã kiểm tra đề xuất #${suggest.id}, chờ duyệt`;
      } else {
        message = `${user?.name} đã từ chối đề xuất #${suggest.id}`;
      }
      payload = new SuggestReviewedEvent(
        saved.id!,

        message,

        reviewedReceiverIds,

        reviewedTokens,

        user.id!,

        status === SuggestStatus.REVIEWED ? 'APPROVED' : 'REJECTED',

        rejectReason,
      );

      return saved;
    });

    // 🔥 emit AFTER commit
    if (payload) {
      this.eventEmitter.emit('suggest.reviewed', payload);
    }

    return saved;
  }
  async approveByDirector(
    id: number,
    status: SuggestStatus,
    user: Employee,
    rejectReason?: string,
  ) {
    let payload: SuggestApprovedEvent | null = null;

    if (!user) {
      throw new UnauthorizedException('User không hợp lệ');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, {
        where: { id },
      });

      if (!suggest) {
        throw new NotFoundException('Suggest not found');
      }

      if (suggest.approvedBy) {
        throw new BadRequestException('Suggest đã được director xử lý');
      }

      // 🔒 role
      if (
        !user.roles?.some((r: string) =>
          ['director', 'director_la', 'troly_gd'].includes(r),
        )
      ) {
        throw new ForbiddenException('Không có quyền duyệt đề xuất');
      }

      // 🔒 status hợp lệ
      if (![SuggestStatus.APPROVED, SuggestStatus.REJECTED].includes(status)) {
        throw new BadRequestException('Chỉ được APPROVED hoặc REJECTED');
      }

      // 📸 history
      await manager.save(SuggestHistory, {
        suggestId: suggest.id,
        data: { ...suggest },
        createdBy: user.id,
      });

      // 🔥 update
      suggest.status = status;
      suggest.approvedBy = user.id;

      if (status === SuggestStatus.REJECTED) {
        if (!rejectReason) {
          throw new BadRequestException('Phải có lý do từ chối');
        }
        suggest.rejectReason = rejectReason;
      } else {
        suggest.rejectReason = null;
      }

      const saved = await manager.save(suggest);

      // Đã chốt duyệt/từ chối — thông báo "cần duyệt" cũ (gửi cả saleadmin,
      // director, ketoan_congno, thuquy) hết ý nghĩa với TẤT CẢ người nhận,
      // không riêng người vừa duyệt. Đánh dấu trước khi phát sự kiện tạo
      // thông báo kết quả bên dưới (cùng type+entityId) để không lỡ tay đánh
      // dấu luôn thông báo kết quả vừa tạo.
      await this.notificationService.markAllAsReadByTypeAndEntity(
        NotificationType.SUGGEST,
        suggest.id!,
      );

      // ================= NOTIFY =================

      // 👤 lấy creator (CHỈ 1 LẦN)
      const creator = await manager.findOne(Employee, {
        where: { id: suggest.createdBy },
      });

      const creatorId = creator?.id;

      // 🔤 message
      const name = fixVietnamese(user?.name || '');

      const message =
        status === SuggestStatus.APPROVED
          ? `${name} đã phê duyệt đề xuất #${suggest.id}`
          : `${name} đã từ chối đề xuất #${suggest.id}`;

      // 🔥 payload chuẩn
      const receiverIds = [creatorId].filter((id): id is number => !!id);

      // 📱 lấy hết token của mọi thiết bị người tạo (không chỉ 1 token)
      const approvedFcmTokens = await manager.find(EmployeeFcmToken, {
        where: { employeeId: In(receiverIds) },
      });
      const tokens = approvedFcmTokens.map((t) => t.token).filter(Boolean);

      payload = new SuggestApprovedEvent({
        suggestId: saved.id!,

        message,

        receiverIds,

        tokens,

        actorId: user.id!,
      });

      return saved;
    });

    // 🔥 emit AFTER commit
    if (payload) {
      this.eventEmitter.emit('suggest.approved', payload);
    }

    return saved;
  }
  async getStatsByPolicy() {
    const results = await this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.policy', 'p')
      .leftJoinAndSelect('p.subject', 'sub')
      .leftJoinAndSelect('sub.school', 'sch')
      .where('s.status = :status', {
        status: SuggestStatus.APPROVED,
      })
      .orderBy('p.id', 'DESC')
      .addOrderBy('s.issueDate', 'DESC')
      .getMany();

    const map = new Map<number, any>();

    for (const suggest of results) {
      const policyId = suggest.policy?.id;

      if (!policyId) continue;

      if (!map.has(policyId)) {
        map.set(policyId, {
          policyId,
          subjectName: suggest.policy?.subject?.name ?? null,
          schoolName: suggest.policy?.subject?.school?.name ?? null,
          total: 0,
          suggests: [],
        });
      }

      const item = map.get(policyId);

      item.total += 1;

      item.suggests.push({
        id: suggest.id,
        content: suggest.content,
        component: suggest.component,
        description: suggest.description,
        issueDate: suggest.issueDate,
        fileUrl: suggest.fileUrl,
      });
    }

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }
  async findByEmployee(employeeId: number) {
    return this.repo.find({
      where: { createdBy: employeeId, type: SuggestType.SUGGESTION },
      relations: ['ward', 'policy', 'policy.subject', 'policy.subject.school'],
      order: { createdAt: 'DESC' },
    });
  }

  // ============================================================
  // =============== LUỒNG ĐỀ XUẤT CHI (EXPENSE) ================
  // ============================================================

  private ensureUser(user?: AuthUser): AuthUser {
    if (!user?.id) {
      throw new UnauthorizedException('User không hợp lệ');
    }
    return user;
  }

  /**
   * Sinh mã tuần tự theo tháng (DX-YYYYMM-xxxx / LC-YYYYMM-xxxx /
   * XK-YYYYMM-xxxx).
   * Advisory lock để 2 request song song không trùng mã.
   */
  private async generateCode(
    manager: EntityManager,
    table:
      | 'suggest'
      | 'suggest_payment_order'
      | 'suggest_stock_issue_order'
      | 'suggest_stock_in_order',
    column: 'code',
    prefixLetter: 'DX' | 'LC' | 'XK' | 'NK',
  ): Promise<string> {
    const prefix = `${prefixLetter}-${vnYearMonth()}-`;

    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${table}_${column}_${prefix}`,
    ]);

    const row: { code: string } | undefined = (
      await manager.query(
        `SELECT ${column} AS code FROM ${table} WHERE ${column} LIKE $1 ORDER BY ${column} DESC LIMIT 1`,
        [`${prefix}%`],
      )
    )[0];

    const seq = row ? parseInt(row.code.slice(prefix.length), 10) + 1 : 1;

    return prefix + String(seq).padStart(4, '0');
  }

  /**
   * Người thực hiện bước gần nhất trên đề xuất — dùng để chặn một người làm
   * hai chốt kiểm soát liên tiếp.
   *
   * Lấy bản ghi lịch sử mới nhất bất kể loại: mọi dòng trong `suggest_history`
   * đều là một thao tác có chủ thể trên đúng đề xuất đó (tạo đơn, kiểm duyệt
   * chính sách, chuyển trạng thái), nên "người vừa động vào đơn này" là đúng
   * thứ cần so.
   */
  private async lastExpenseActorId(
    manager: EntityManager,
    suggestId: number,
  ): Promise<number | null> {
    const last = await manager.findOne(SuggestHistory, {
      where: { suggestId },
      order: { id: 'DESC' },
    });
    return last?.userId ?? null;
  }

  private async writeExpenseLog(
    manager: EntityManager,
    data: {
      suggestId: number;
      userId: number;
      action: ExpenseAction;
      fromStatus?: SuggestStatus | null;
      toStatus?: SuggestStatus | null;
      note?: string | null;
      /** Ảnh chụp thông tin của bước tại thời điểm thực hiện — hiện ở Lịch sử. */
      details?: Record<string, unknown> | null;
    },
  ) {
    await manager.save(SuggestHistory, {
      suggestId: data.suggestId,
      userId: data.userId,
      action: data.action,
      fromStatus: data.fromStatus ?? null,
      toStatus: data.toStatus ?? null,
      note: data.note ?? null,
      data: data.details ?? {},
    });
  }

  /** Tên tiếng Việt của role giữ bước — hiện ở "Người xử lý tiếp theo" trong lịch sử. */
  private static readonly EXPENSE_ROLE_LABEL: Record<string, string> = {
    [ExpenseRole.DIRECTOR]: 'Giám đốc',
    [ExpenseRole.SALES_ADMIN]: 'Sales Admin',
    [ExpenseRole.CHIEF_ACCOUNTANT]: 'Kế toán trưởng',
    [ExpenseRole.ACCOUNTANT]: 'Kế toán',
    [ExpenseRole.DEBT_ACCOUNTANT]: 'Kế toán công nợ',
    [ExpenseRole.TREASURER]: 'Thủ quỹ',
    [ExpenseRole.TECHNICAL]: 'Phòng kỹ thuật',
    [ExpenseRole.SALES]: 'Kinh doanh',
    [ExpenseRole.STAFF_TEACHER]: 'Giáo viên công ty',
  };

  /**
   * Ai xử lý bước kế tiếp + ai là người nghiệm thu, chụp ngay sau mỗi bước để
   * lịch sử ghi rõ việc đang nằm ở ai. Người cụ thể (chủ đơn, người được chỉ
   * định) thì ghi tên; còn lại ghi theo bộ phận.
   */
  private async expenseNextStepDetails(
    manager: EntityManager,
    s: Suggest,
  ): Promise<Record<string, unknown>> {
    const kind = s.requestKind ?? ExpenseRequestKind.CASH;
    const holder = expenseActorForStatus(
      s.status as SuggestStatus,
      kind,
      s.equipmentSource,
      s.isMonthlyExpense,
      s.approvalFlow,
    );

    let personIds: number[] = [];
    let roles: string[] = [];
    if (holder?.owner && s.createdBy) {
      personIds = [s.createdBy];
    } else if (holder?.assignee) {
      const id = this.expenseAssigneeId(s, holder.assignee);
      if (id) personIds = [id];
    } else if (holder) {
      // Đã chỉ định người bàn giao thì chỉ người đó giữ bước kỹ thuật.
      if (holder.roles.includes(ExpenseRole.TECHNICAL) && s.assignedTechnicianId) {
        personIds = [s.assignedTechnicianId];
      } else {
        roles = holder.roles;
      }
    } else if (s.status === SuggestStatus.REPAIR_REJECTED) {
      roles = [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN];
    }

    const people = await this.employeeRefs(manager, [...personIds, s.acceptorId]);
    return {
      next:
        personIds.length || roles.length
          ? {
              people: personIds.map((id) => people.get(id) ?? { id }),
              departments: roles.map(
                (r) => SuggestService.EXPENSE_ROLE_LABEL[r] ?? r,
              ),
            }
          : null,
      acceptor: s.acceptorId ? people.get(s.acceptorId) ?? { id: s.acceptorId } : null,
    };
  }

  /** Tên + SĐT nhân viên để ghi vào lịch sử (không phụ thuộc dữ liệu về sau bị đổi). */
  private async employeeRefs(
    manager: EntityManager,
    ids: (number | null | undefined)[],
  ): Promise<Map<number, { id: number; name: string | null; phone: string | null }>> {
    const unique = [...new Set(ids.filter((id): id is number => !!id))];
    if (unique.length === 0) return new Map();
    const rows = await manager.find(Employee, {
      where: { id: In(unique) },
      select: { id: true, name: true, phone: true },
    });
    return new Map(
      rows.map((e) => [
        e.id!,
        {
          id: e.id!,
          name: e.name ? fixVietnamese(e.name) : null,
          phone: e.phone ?? null,
        },
      ]),
    );
  }

  private async saveExpenseAttachments(
    manager: EntityManager,
    suggestId: number,
    files: UploadedAttachment[] | undefined,
    uploadedBy: number,
    action?: ExpenseAction,
  ) {
    if (!files?.length) return;

    await manager.save(
      SuggestAttachment,
      files.map((f) => ({
        suggestId,
        fileUrl: f.fileUrl,
        fileName: f.fileName,
        uploadedBy,
        action,
      })),
    );
  }

  /**
   * Gửi thông báo cho luồng đề xuất chi: DB + socket (NotificationService)
   * + push FCM. Không để lỗi FCM làm hỏng nghiệp vụ.
   */
  private async notifyExpense(
    payload: {
      suggestId: number;
      title: string;
      message: string;
      senderId?: number;
      meta?: Record<string, any>;
    },
    target: { roles?: string[]; userIds?: number[] },
  ) {
    const roleIds = await this.getEmployeeIdsByRoles(target.roles ?? []);

    const receiverIds = [
      ...new Set([...roleIds, ...(target.userIds ?? [])]),
    ].filter((id) => id && id !== payload.senderId);

    if (receiverIds.length === 0) return;

    // Gắn "nhân viên kinh doanh" (người tạo đề xuất) vào meta để FE có thể gom
    // nhóm thông báo theo nhân viên. Lỗi tra cứu không được làm hỏng việc gửi.
    let owner: {
      employeeId?: number;
      employeeName?: string;
      employeePhone?: string;
      suggestCode?: string;
    } = {};
    try {
      const suggest = await this.repo.findOne({
        where: { id: payload.suggestId },
        relations: ['createdByUser'],
      });
      if (suggest?.createdBy) {
        owner = {
          employeeId: suggest.createdBy,
          employeeName: suggest.createdByUser?.name
            ? fixVietnamese(suggest.createdByUser.name)
            : undefined,
          employeePhone: suggest.createdByUser?.phone,
          suggestCode: suggest.code ?? undefined,
        };
      }
    } catch (error) {
      this.logger.error('Resolve expense owner for notify failed', error as any);
    }

    // Thông báo đề xuất chi nằm chung trong phần "đề xuất" (type SUGGEST);
    // meta.suggestType giúp FE phân biệt & điều hướng đúng màn đề xuất chi.
    // meta.employeeId/employeeName = nhân viên kinh doanh sở hữu đề xuất.
    const meta = {
      suggestId: payload.suggestId,
      suggestType: SuggestType.EXPENSE_REQUEST,
      ...owner,
      ...payload.meta,
    };

    await this.notificationService.createNotifications({
      receiverIds,
      type: NotificationType.SUGGEST,
      entityId: payload.suggestId,
      message: payload.message,
      senderId: payload.senderId,
      meta,
    });

    try {
      const fcmTokens = await this.dataSource
        .getRepository(EmployeeFcmToken)
        .find({
          where: { employeeId: In(receiverIds) },
        });

      const tokens = [
        ...new Set(fcmTokens.map((t) => t.token).filter(Boolean)),
      ];

      if (tokens.length > 0) {
        await this.fcmService.sendToMultiple(
          tokens,
          payload.title,
          payload.message,
          {
            type: 'expense_request',
            id: String(payload.suggestId),
            url: `/expense-requests/${payload.suggestId}`,
          },
        );
      }
    } catch (error) {
      this.logger.error('FCM push (expense) failed', error as any);
    }
  }

  private async getEmployeeIdsByRoles(roles: string[]): Promise<number[]> {
    if (roles.length === 0) return [];

    const employees = await this.employeeRepo
      .createQueryBuilder('e')
      .select(['e.id'])
      .where(`e.roles && ARRAY[:...roles]::text[]`, { roles })
      .andWhere('e."isActive" = true')
      .getMany();

    return employees.map((e) => e.id).filter((id): id is number => !!id);
  }

  /**
   * Khung chung cho mọi bước chuyển trạng thái của đề xuất chi:
   * lock row → validate state machine → mutate → save → audit log.
   * Tất cả trong 1 transaction (atomic, chống double-submit).
   */
  private async expenseTransition(opts: {
    id: number;
    action: ExpenseAction;
    user: AuthUser;
    note?: string;
    mutate?: (s: Suggest) => void;
    extra?: (manager: EntityManager, s: Suggest) => Promise<void>;
    /** Thông tin của bước ghi vào lịch sử — tính sau `extra` (đã có mã phiếu…). */
    logData?: (
      manager: EntityManager,
      s: Suggest,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  }): Promise<Suggest> {
    const user = this.ensureUser(opts.user);

    return this.dataSource.transaction(async (manager) => {
      const s = await manager.findOne(Suggest, {
        where: { id: opts.id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!s) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }

      if (s.type !== SuggestType.EXPENSE_REQUEST) {
        throw new BadRequestException(
          'Đề xuất này không phải luồng đề xuất chi',
        );
      }

      const technicalActions: ExpenseAction[] = [
        ExpenseAction.CREATE_STOCK_ISSUE_ORDER,
        ExpenseAction.CONFIRM_EQUIPMENT_RETURNED,
        ExpenseAction.ACCEPT_REPAIR,
        ExpenseAction.REJECT_REPAIR,
      ];
      if (
        technicalActions.includes(opts.action) &&
        s.assignedTechnicianId != null &&
        s.assignedTechnicianId !== user.id
      ) {
        throw new ForbiddenException(
          'Đề xuất này đã được giao cho một nhân viên kỹ thuật khác',
        );
      }
      if (
        technicalActions.includes(opts.action) &&
        opts.action !== ExpenseAction.CONFIRM_EQUIPMENT_RETURNED &&
        (await manager.count(SuggestAssignment, {
          where: {
            suggestId: opts.id,
            employeeId: user.id,
            role: AssignmentRole.HANDOVER,
            status: AssignmentStatus.DECLINED,
          },
        })) > 0
      ) {
        throw new ForbiddenException(
          'Bạn đã từ chối bàn giao đề xuất này, chờ Giám đốc chọn người thay thế',
        );
      }

      const fromStatus = s.status as SuggestStatus;
      const assignee = EXPENSE_TRANSITIONS[opts.action]?.assignee;

      s.status = assertExpenseTransition(opts.action, fromStatus, {
        actorRoles: user.roles ?? [],
        kind: s.requestKind ?? ExpenseRequestKind.CASH,
        equipmentSource: s.equipmentSource,
        isOwner: s.createdBy === user.id,
        actorId: user.id,
        previousActorId: await this.lastExpenseActorId(manager, opts.id),
        isAssignee: assignee
          ? this.expenseAssigneeId(s, assignee) === user.id
          : false,
      });

      opts.mutate?.(s);

      const saved = await manager.save(s);

      if (opts.extra) {
        await opts.extra(manager, saved);
      }

      await this.writeExpenseLog(manager, {
        suggestId: saved.id!,
        userId: user.id,
        action: opts.action,
        fromStatus,
        toStatus: saved.status as SuggestStatus,
        note: opts.note ?? null,
        details: {
          ...(opts.logData ? await opts.logData(manager, saved) : {}),
          ...(await this.expenseNextStepDetails(manager, saved)),
        },
      });

      // Bước vừa xong thì lời nhắc "đến lượt bạn" của những người CÙNG giữ
      // bước đó hết ý nghĩa — đánh dấu đã đọc cho cả nhóm, không chỉ người
      // vừa bấm. Đặt trong transition (chốt chung của MỌI bước) nên áp dụng
      // đồng loạt cho duyệt/từ chối, lên lệnh chi, xuất quỹ, hoàn quỹ...
      // Chạy TRƯỚC khi nơi gọi tạo thông báo cho bước kế tiếp, để không lỡ
      // tay đánh dấu luôn thông báo vừa tạo.
      await this.markExpenseStepNotificationsRead(saved, fromStatus, user);

      return saved;
    });
  }

  /** Id người được Giám đốc chỉ định giữ bước (đề xuất thiết bị mới). */
  private expenseAssigneeId(
    s: Suggest,
    assignee: 'stockInHandler' | 'acceptor',
  ): number | null {
    return (
      (assignee === 'acceptor' ? s.acceptorId : s.stockInHandlerId) ?? null
    );
  }

  /**
   * Đánh dấu đã đọc thông báo của đúng nhóm vừa hoàn thành bước.
   *
   * Chỉ nhắm nhóm giữ bước `fromStatus` (theo `expenseActorForStatus`) chứ
   * không quét sạch mọi thông báo của đề xuất: các nhóm khác (người tạo đơn,
   * bộ phận ở bước sau) vẫn cần thấy thông báo kết quả của họ ở trạng thái
   * chưa đọc. Lỗi ở đây không được làm hỏng bước chuyển trạng thái.
   */
  private async markExpenseStepNotificationsRead(
    suggest: Suggest,
    fromStatus: SuggestStatus,
    actor: AuthUser,
  ) {
    try {
      const holder = expenseActorForStatus(
        fromStatus,
        suggest.requestKind ?? ExpenseRequestKind.CASH,
        suggest.equipmentSource,
        suggest.isMonthlyExpense,
        suggest.approvalFlow,
      );
      const receiverIds = [actor.id];

      if (holder?.owner && suggest.createdBy) {
        receiverIds.push(suggest.createdBy);
      }
      if (holder && !holder.owner) {
        receiverIds.push(...(await this.getEmployeeIdsByRoles(holder.roles)));
      }
      const assigneeId = holder?.assignee
        ? this.expenseAssigneeId(suggest, holder.assignee)
        : null;
      if (assigneeId) receiverIds.push(assigneeId);

      await this.notificationService.markAsReadByTypeEntityForReceivers(
        NotificationType.SUGGEST,
        suggest.id!,
        receiverIds,
      );
    } catch (error) {
      this.logger.error(
        'Đánh dấu đã đọc thông báo đề xuất chi lỗi',
        error as any,
      );
    }
  }

  // =========== BƯỚC 1.5 — SALES ADMIN kiểm duyệt (song song) ===========
  // Kiểm duyệt của Sales Admin KHÔNG chặn giám đốc: status vẫn giữ
  // PENDING_APPROVAL để giám đốc duyệt/từ chối bình thường. Nếu từ chối
  // chính sách thì lưu ghi chú và báo cho người tạo + giám đốc.

  async reviewExpenseBySaleAdmin(
    id: number,
    user: AuthUser,
    input: { status: 'REVIEWED' | 'REJECTED'; note?: string },
  ) {
    const actor = this.ensureUser(user);

    const note = input.note?.trim() || null;
    if (input.status === 'REJECTED' && !note) {
      throw new BadRequestException('Phải có ghi chú khi từ chối chính sách');
    }

    const saved = await this.dataSource.transaction(async (manager) => {
      const s = await manager.findOne(Suggest, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!s) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }
      if (s.type !== SuggestType.EXPENSE_REQUEST) {
        throw new BadRequestException(
          'Đề xuất này không phải luồng đề xuất chi',
        );
      }
      if (s.isMonthlyExpense) {
        throw new BadRequestException(
          'Đề xuất chi tháng không qua bước kiểm duyệt của Sales Admin',
        );
      }
      // Chỉ kiểm duyệt khi đề xuất còn đang chờ giám đốc duyệt.
      if (s.status !== SuggestStatus.PENDING_APPROVAL) {
        throw new BadRequestException(
          'Chỉ kiểm duyệt khi đề xuất đang chờ giám đốc duyệt',
        );
      }

      // Kiểm duyệt chính sách là chốt kiểm soát, không phải việc của người đề
      // xuất — cùng nguyên tắc phân tách nhiệm vụ với `assertExpenseTransition`.
      // Bước này nằm ngoài state machine nên phải kiểm riêng ở đây.
      if (s.createdBy === actor.id) {
        throw new ForbiddenException(
          'Bạn là người tạo đề xuất này nên không được tự kiểm duyệt chính sách',
        );
      }

      // Cùng luật "hai chốt liên tiếp phải hai người" như trong state machine.
      if ((await this.lastExpenseActorId(manager, id)) === actor.id) {
        throw new ForbiddenException(
          'Bạn vừa thực hiện bước liền trước của đề xuất này nên không được kiểm duyệt tiếp. ' +
            'Hai bước kiểm soát liên tiếp phải do hai người khác nhau.',
        );
      }

      s.saleadminReviewStatus = input.status;
      s.saleadminNote = note;
      s.saleadminReviewedBy = actor.id;
      s.saleadminReviewedAt = new Date();

      const savedS = await manager.save(s);

      await this.writeExpenseLog(manager, {
        suggestId: savedS.id!,
        userId: actor.id,
        action:
          input.status === 'REJECTED'
            ? ExpenseAction.SALE_ADMIN_REJECT
            : ExpenseAction.SALE_ADMIN_REVIEW,
        // status không đổi — ghi cùng from/to để giữ nguyên audit
        fromStatus: SuggestStatus.PENDING_APPROVAL,
        toStatus: SuggestStatus.PENDING_APPROVAL,
        note,
      });

      return savedS;
    });

    // Kiểm duyệt chính sách là bước TRUNG GIAN: đề xuất vẫn chờ duyệt, giám
    // đốc/Sales Admin khác vẫn phải thấy "cần duyệt". Chỉ đánh dấu đã đọc cho
    // đúng người vừa kiểm duyệt.
    try {
      await this.notificationService.markAsReadByTypeEntityForReceiver(
        NotificationType.SUGGEST,
        saved.id!,
        actor.id,
      );
    } catch (error) {
      this.logger.error(
        'Đánh dấu đã đọc thông báo kiểm duyệt chính sách lỗi',
        error as any,
      );
    }

    // Báo cho người tạo đề xuất + giám đốc (không chặn giám đốc duyệt)
    const isReject = input.status === 'REJECTED';
    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: isReject
          ? '⚠️ Sales Admin từ chối chính sách'
          : '🔍 Sales Admin đã kiểm duyệt',
        message: isReject
          ? `Sales Admin đã từ chối chính sách đề xuất ${saved.code}: ${note}.` +
            ` Giám đốc vẫn có thể duyệt.`
          : `Sales Admin đã kiểm duyệt đề xuất ${saved.code}` +
            (note ? `: ${note}` : ''),
        senderId: actor.id,
        meta: {
          kind: isReject ? 'saleadmin_reject' : 'saleadmin_review',
          saleadminReviewStatus: input.status,
          saleadminNote: note,
        },
      },
      {
        roles: [ExpenseRole.DIRECTOR],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return this.findOneExpense(saved.id!);
  }

  // ======= BƯỚC 2 — DIRECTOR / SALES ADMIN duyệt / từ chối (ngang quyền) =======

  /**
   * Ai vừa chốt duyệt/từ chối — để thông báo nói đúng người, không mặc định
   * "giám đốc" nữa vì Sales Admin cũng duyệt được cùng chốt này.
   */
  private expenseApproverLabel(user: AuthUser) {
    if (user.roles?.includes(ExpenseRole.DIRECTOR)) return 'giám đốc';
    if (user.roles?.includes(ExpenseRole.CHIEF_ACCOUNTANT))
      return 'kế toán trưởng';
    return 'Sales Admin';
  }

  /**
   * Kiểm tra dữ liệu Giám đốc gửi khi duyệt thiết bị mua từ nhà cung cấp: phiếu nhập
   * dự kiến, người xử lý và người nghiệm thu. Người xử lý, người nghiệm thu
   * và người duyệt phải là ba người khác nhau — mỗi bước kiểm soát một người
   * (xem ràng buộc "hai bước liên tiếp" ở `assertExpenseTransition`).
   */
  private async validatePurchaseApproval(dto: ApproveExpenseDto, user: AuthUser) {
    if (!dto.stockInItems?.length) {
      throw new BadRequestException(
        'Phiếu nhập kho phải có ít nhất 1 thiết bị',
      );
    }
    if (!dto.stockInHandlerId) {
      throw new BadRequestException('Vui lòng chọn nhân viên xử lý phiếu nhập');
    }
    if (!dto.acceptorId) {
      throw new BadRequestException('Vui lòng chọn người nghiệm thu bàn giao');
    }
    if (dto.stockInHandlerId === dto.acceptorId) {
      throw new BadRequestException(
        'Người xử lý phiếu nhập và người nghiệm thu phải là hai người khác nhau',
      );
    }
    if (dto.stockInHandlerId === user.id) {
      throw new BadRequestException(
        'Người duyệt không được tự nhận xử lý phiếu nhập kho',
      );
    }

    const [handler, acceptor] = await Promise.all(
      [dto.stockInHandlerId, dto.acceptorId].map((id) =>
        this.employeeRepo.findOne({ where: { id, isActive: true } }),
      ),
    );
    if (!handler) {
      throw new NotFoundException('Nhân viên xử lý không tồn tại hoặc đã nghỉ');
    }
    if (!acceptor) {
      throw new NotFoundException('Người nghiệm thu không tồn tại hoặc đã nghỉ');
    }

    const items = this.normalizeStockInItems(dto.stockInItems);
    return { items, total: this.stockInTotal(items), handler, acceptor };
  }

  private normalizeStockInItems(
    items: CreateStockInReceiptDto['items'],
  ): StockInItem[] {
    return items.map((it) => {
      const name = it.name?.trim();
      if (!name) {
        throw new BadRequestException('Tên thiết bị không được để trống');
      }
      return {
        name,
        quantity: it.quantity,
        unit: it.unit?.trim() || null,
        unitPrice: it.unitPrice ?? null,
        note: it.note?.trim() || null,
        warehouseItemId: it.warehouseItemId ?? null,
      };
    });
  }

  private stockInTotal(items: StockInItem[]): number {
    return items.reduce(
      (sum, it) => sum + (Number(it.unitPrice) || 0) * it.quantity,
      0,
    );
  }

  async approveExpense(
    id: number,
    user: AuthUser,
    dto: ApproveExpenseDto,
  ) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }

    if (existing.isMonthlyExpense) {
      if (dto.requestKind && dto.requestKind !== ExpenseRequestKind.CASH) {
        throw new BadRequestException('Đề xuất chi tháng chỉ được chi bằng tiền');
      }
      if (
        dto.equipmentSource ||
        dto.assignedTechnicianId ||
        dto.supporterIds?.length ||
        dto.stockInItems?.length ||
        dto.stockInHandlerId ||
        dto.acceptorId
      ) {
        throw new BadRequestException(
          'Đề xuất chi tháng không dùng thông tin thiết bị/sửa chữa',
        );
      }
      return isMonthlyChain(existing)
        ? this.approveMonthlyChain(id, user, dto)
        : this.approveMonthlyExpense(id, user, dto);
    }

    if (!dto?.requestKind) {
      throw new BadRequestException(
        'Giám đốc phải chọn loại đề xuất khi duyệt',
      );
    }

    const nextKind = dto.requestKind;
    const isEquipment = nextKind === ExpenseRequestKind.EQUIPMENT;
    if (dto.equipmentSource && !isEquipment) {
      throw new BadRequestException(
        'Chỉ chọn nguồn thiết bị cho đề xuất thiết bị',
      );
    }
    const equipmentSource = isEquipment
      ? dto.equipmentSource ?? EquipmentSource.STOCK
      : null;
    const fromSupplier = equipmentSource === EquipmentSource.SUPPLIER;
    // Thiết bị từ nhà cung cấp đi theo người xử lý/nghiệm thu do Giám đốc
    // chỉ định, không qua phòng kỹ thuật.
    const needsTechnical =
      (isEquipment && !fromSupplier) ||
      nextKind === ExpenseRequestKind.REPAIR;

    const purchase = fromSupplier
      ? await this.validatePurchaseApproval(dto, user)
      : null;
    if (
      !fromSupplier &&
      (dto.stockInItems?.length || dto.stockInHandlerId || dto.acceptorId)
    ) {
      throw new BadRequestException(
        'Phiếu nhập kho, người xử lý và người nghiệm thu chỉ dùng cho thiết bị mua từ nhà cung cấp',
      );
    }

    if (dto.assignedTechnicianId && !needsTechnical) {
      throw new BadRequestException(
        'Chỉ chỉ định nhân viên kỹ thuật cho đề xuất thiết bị lấy từ kho hoặc sửa chữa',
      );
    }

    // Lấy từ kho thì cần biết kinh doanh muốn thiết bị gì; mua từ nhà cung
    // cấp thì danh sách đã nằm trong phiếu nhập kho Giám đốc vừa lập.
    if (
      isEquipment &&
      !fromSupplier &&
      !(existing.requestedItems && existing.requestedItems.length > 0)
    ) {
      throw new BadRequestException(
        'Vui lòng chọn ít nhất một thiết bị trước khi duyệt đề xuất',
      );
    }

    let technician: Employee | null = null;
    if (dto.assignedTechnicianId) {
      technician = await this.employeeRepo.findOne({
        where: { id: dto.assignedTechnicianId },
      });
      if (!technician) {
        throw new NotFoundException('Người bàn giao không tồn tại');
      }
      if (!technician.roles?.includes(ExpenseRole.TECHNICAL)) {
        throw new BadRequestException(
          'Người bàn giao phải thuộc phòng kỹ thuật',
        );
      }
    }

    const supporterIds = [...new Set(dto.supporterIds ?? [])];
    if (supporterIds.length > 0) {
      if (!needsTechnical || !dto.assignedTechnicianId) {
        throw new BadRequestException(
          'Chỉ chọn người hỗ trợ khi đã chọn người bàn giao',
        );
      }
      await this.assertAssignableEmployees(supporterIds, [
        dto.assignedTechnicianId,
      ]);
    }

    let stockInCode: string | null = null;

    const managementSnapshot = await this.managementExpenseSnapshot(existing);
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.APPROVE,
      user,
      note: dto.note?.trim() || undefined,
      logData: async (manager, s) => {
        const people = await this.employeeRefs(manager, [
          s.assignedTechnicianId,
          ...supporterIds,
          purchase?.handler.id,
          purchase?.acceptor.id,
        ]);
        return {
          requestKind: s.requestKind,
          amount: s.amount != null ? Number(s.amount) : null,
          equipmentSource: s.equipmentSource ?? null,
          handover: s.assignedTechnicianId
            ? people.get(s.assignedTechnicianId) ?? null
            : null,
          supporters: s.assignedTechnicianId
            ? supporterIds.map((sid) => people.get(sid) ?? { id: sid })
            : [],
          stockIn: purchase
            ? {
                code: stockInCode,
                items: purchase.items,
                total: purchase.total,
                note: dto.stockInNote?.trim() || null,
                handler: people.get(purchase.handler.id!) ?? null,
                acceptor: people.get(purchase.acceptor.id!) ?? null,
              }
            : null,
          ...managementSnapshot,
        };
      },
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = null;
        // Mua từ nhà cung cấp: số tiền luôn tự tính = tổng thành tiền các
        // thiết bị trong phiếu nhập dự kiến, không lấy số gõ tay.
        if (purchase) s.amount = purchase.total;
        else if (dto.amount !== undefined) s.amount = dto.amount;
        s.requestKind = nextKind;
        // Khi đổi về tiền phải xoá người kỹ thuật của vòng duyệt trước.
        s.assignedTechnicianId = needsTechnical
          ? dto.assignedTechnicianId ?? null
          : null;
        s.equipmentSource = equipmentSource;
        s.stockInHandlerId = purchase ? purchase.handler.id : null;
        s.acceptorId = purchase ? purchase.acceptor.id : null;
        if (dto.note !== undefined) s.approveNote = dto.note || null;
      },
      extra: async (manager, s) => {
        // Duyệt lại thì giao việc lại từ đầu: người được giao ở vòng trước
        // (kể cả người đã từ chối) không còn giá trị.
        await manager.delete(SuggestAssignment, { suggestId: s.id! });
        if (s.assignedTechnicianId) {
          await manager.save(SuggestAssignment, [
            {
              suggestId: s.id!,
              employeeId: s.assignedTechnicianId,
              role: AssignmentRole.HANDOVER,
              assignedBy: user.id,
            },
            ...supporterIds.map((employeeId) => ({
              suggestId: s.id!,
              employeeId,
              role: AssignmentRole.SUPPORT,
              assignedBy: user.id,
            })),
          ]);
        }

        // Phiếu dự kiến của vòng duyệt trước (nếu có) không còn giá trị.
        await manager.delete(SuggestStockInOrder, { suggestId: s.id! });
        if (!purchase) return;

        const code = await this.generateCode(
          manager,
          'suggest_stock_in_order',
          'code',
          'NK',
        );
        stockInCode = code;
        await manager.save(SuggestStockInOrder, {
          code,
          suggestId: s.id!,
          draftItems: purchase.items,
          draftNote: dto.stockInNote?.trim() || null,
          createdBy: user.id,
        });
      },
    });

    if (purchase) {
      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title: '📥 Bạn được giao xử lý phiếu nhập kho',
          message:
            `Đề xuất ${saved.code} (thiết bị mua từ nhà cung cấp) đã được duyệt,` +
            ` bạn được chỉ định lập phiếu nhập kho`,
          senderId: user.id,
          meta: { status: saved.status },
        },
        { userIds: [purchase.handler.id!] },
      );
      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title: '📋 Bạn được chỉ định nghiệm thu bàn giao',
          message:
            `Bạn là người nghiệm thu bàn giao đề xuất ${saved.code},` +
            ` sẽ được báo khi thiết bị đã nhập kho`,
          senderId: user.id,
          meta: { status: saved.status },
        },
        { userIds: [purchase.acceptor.id!] },
      );
    }

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '✅ Đề xuất chi đã duyệt',
        message: `Đề xuất ${saved.code} đã được ${this.expenseApproverLabel(user)} duyệt`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      {
        // Báo cả Giám đốc lẫn Sales Admin: hai người cùng giữ chốt duyệt này,
        // ai không phải người vừa chốt thì vẫn cần biết đề xuất đã được xử lý.
        roles: [
          ExpenseRole.TREASURER,
          ExpenseRole.SALES_ADMIN,
          ExpenseRole.DIRECTOR,
          ExpenseRole.DEBT_ACCOUNTANT,
          ExpenseRole.CHIEF_ACCOUNTANT,
        ],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    if (technician?.id) {
      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title:
            saved.requestKind === ExpenseRequestKind.REPAIR
              ? '🛠️ Bạn được chỉ định đảm nhận sửa chữa'
              : '🛠️ Bạn được chỉ định bàn giao đề xuất',
          message:
            saved.requestKind === ExpenseRequestKind.REPAIR
              ? `Bạn là người đảm nhận chính đề xuất sửa chữa ${saved.code}`
              : `Bạn là người bàn giao đề xuất thiết bị ${saved.code}`,
          senderId: user.id,
          meta: { status: saved.status },
        },
        { userIds: [technician.id] },
      );
      if (supporterIds.length > 0) {
        await this.notifyExpense(
          {
            suggestId: saved.id!,
            title: '🤝 Bạn được chỉ định hỗ trợ',
            message:
              `Bạn được chỉ định hỗ trợ ${fixVietnamese(technician.name ?? '')}` +
              (saved.requestKind === ExpenseRequestKind.REPAIR
                ? ` sửa chữa theo đề xuất ${saved.code}`
                : ` bàn giao đề xuất ${saved.code}`),
            senderId: user.id,
            meta: { status: saved.status },
          },
          { userIds: supporterIds },
        );
      }
    } else if (needsTechnical) {
      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title: '🛠️ Đề xuất mới của phòng kỹ thuật',
          message: `Đề xuất ${saved.code} (${saved.requestKind === ExpenseRequestKind.REPAIR ? 'sửa chữa' : 'thiết bị'}) cần phòng kỹ thuật xử lý`,
          senderId: user.id,
          meta: { status: saved.status },
        },
        { roles: [ExpenseRole.TECHNICAL] },
      );
    }

    return saved;
  }

  /**
   * Giám đốc duyệt chi tháng không cần nhập số tiền: chưa có lệnh chi thì hệ
   * thống lập lệnh chi bằng tổng cột "Còn chi" của bảng Chi Ngoài các trường
   * trong đề xuất, đúng bảng Giám đốc đang xem. Đã có lệnh chi (Kế toán công nợ
   * lập lại sau hoàn quỹ, sửa số tiền, hoặc đề xuất cũ đã nhập tiền) thì giữ
   * số đó. Duyệt xong giao Thủ quỹ xuất tiền.
   */
  private async approveMonthlyExpense(
    id: number,
    user: AuthUser,
    dto: ApproveExpenseDto,
  ) {
    if (dto.requestKind && dto.requestKind !== ExpenseRequestKind.CASH) {
      throw new BadRequestException('Đề xuất chi tháng chỉ được chi bằng tiền');
    }
    if (
      dto.equipmentSource ||
      dto.assignedTechnicianId ||
      dto.supporterIds?.length ||
      dto.stockInItems?.length ||
      dto.stockInHandlerId ||
      dto.acceptorId
    ) {
      throw new BadRequestException(
        'Đề xuất chi tháng không dùng thông tin thiết bị/sửa chữa',
      );
    }

    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }
    const source = cashflowSourceOf(existing) ?? 'MANAGEMENT';
    const table = CASHFLOW_TABLE_LABELS[source];
    // Đã có lệnh chi thì bảng chỉ để chụp vào lịch sử, đọc lỗi vẫn cho duyệt.
    // Chưa có lệnh chi thì số tiền lấy từ bảng nên đọc lỗi là dừng duyệt.
    // Chi Trường / Giáo viên trường đọc số trong transaction duyệt.
    let sections: ManagementViewSection[] | null = null;
    if (source === 'MANAGEMENT') {
      try {
        sections = await this.loadManagementExpenseSections(existing);
      } catch (error) {
        this.logger.error(
          `Không đọc được bảng Chi Ngoài của đề xuất ${id}`,
          error as Error,
        );
      }
    }
    const remainingTotal = sections ? monthlyRemainingTotal(sections) : 0;
    const managementSnapshot = sections
      ? { managementExpense: { capturedAt: new Date().toISOString(), sections } }
      : {};
    let paymentOrder: SuggestPaymentOrder | null = null;
    let autoAmount = false;
    // Chi Trường / Giáo viên trường: Còn chi từng khoản lúc duyệt (lưu vào lịch sử).
    let cashflowAmounts: number[] | null = null;
    let decided: { id: number; label: string; amount: number; approved: boolean }[] = [];
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.APPROVE_MONTHLY,
      user,
      note: dto.note?.trim() || undefined,
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = null;
        s.requestKind = ExpenseRequestKind.CASH;
        if (dto.note !== undefined) s.approveNote = dto.note || null;
      },
      extra: async (manager, s) => {
        paymentOrder = await manager.findOne(SuggestPaymentOrder, {
          where: { suggestId: s.id! },
        });
        const rows = await manager.find(SuggestMonthlyItem, {
          where: { suggestId: s.id! },
          relations: {
            school: true,
            subject: { catalog: true },
            schoolTeacher: true,
            expensePeriod: true,
          },
          order: { position: 'ASC', id: 'ASC' },
        });
        if (paymentOrder) {
          // Số tiền do Kế toán lập cho cả đề xuất: không bỏ bớt trường được.
          if (dto.approvedItemIds && dto.approvedItemIds.length < rows.length) {
            throw new BadRequestException(
              'Lệnh chi do Kế toán lập cho cả đề xuất nên không bỏ bớt trường khi duyệt được — từ chối để nhân viên sửa',
            );
          }
          return;
        }
        if (source === 'MANAGEMENT' && !sections) {
          throw new BadRequestException(
            'Không đọc được bảng Chi Ngoài để lập lệnh chi, vui lòng thử lại',
          );
        }
        // Đề xuất cũ chưa có dòng trường: một trường, lấy cả bảng.
        if (rows.length === 0 && dto.approvedItemIds) {
          throw new BadRequestException('Đề xuất chỉ có một trường');
        }
        if (source !== 'MANAGEMENT' && rows.length === 0) {
          throw new BadRequestException('Đề xuất chưa có khoản chi nào');
        }
        const amounts =
          source === 'MANAGEMENT'
            ? monthlyItemAmounts(rows, sections!)
            : await this.cashflowItemAmounts(manager, source, rows);
        const { approvedIds, total } =
          rows.length > 0
            ? selectApprovedItems(rows, amounts, dto.approvedItemIds)
            : { approvedIds: new Set<number>(), total: remainingTotal };
        cashflowAmounts = source === 'MANAGEMENT' ? null : amounts;
        const excludedCount = rows.filter((row) => !approvedIds.has(row.id)).length;
        if (excludedCount > 0 && !dto.note?.trim()) {
          throw new BadRequestException(
            'Phải ghi lý do không duyệt các trường bỏ chọn',
          );
        }
        if (!(total > 0)) {
          throw new BadRequestException(
            excludedCount > 0
              ? 'Các trường được chọn không còn khoản nào cần chi (Còn chi = 0) nên không duyệt được'
              : `Bảng ${table} của các trường trong đề xuất không còn khoản nào cần chi (Còn chi = 0) nên không duyệt được`,
          );
        }
        autoAmount = true;
        const code = await this.generateCode(
          manager,
          'suggest_payment_order',
          'code',
          'LC',
        );
        paymentOrder = await manager.save(SuggestPaymentOrder, {
          code,
          suggestId: s.id!,
          amount: total,
          // Ghi tạm Tiền mặt; Thủ quỹ chọn tài khoản xuất thì đổi theo.
          paymentMethod: PaymentMethod.CASH,
          note: null,
          createdBy: user.id,
        });
        s.amount = total;
        await manager.update(Suggest, { id: s.id! }, { amount: total });
        // Phần của từng trường trong lệnh chi — để sau này chi một phần chỉ
        // cần chọn trường, không phải nhập số. Trường không duyệt không có phần.
        for (const [index, row] of rows.entries()) {
          const approved = approvedIds.has(row.id);
          await manager.update(
            SuggestMonthlyItem,
            { id: row.id },
            {
              approvedAmount: approved ? amounts[index] : null,
              spent: null,
              excluded: !approved,
            },
          );
        }
        decided = rows.map((row, index) => ({
          id: row.id,
          label: monthlyItemLabel(row),
          amount: amounts[index],
          approved: approvedIds.has(row.id),
        }));
      },
      logData: () => ({
        requestKind: ExpenseRequestKind.CASH,
        amount: paymentOrder ? Number(paymentOrder.amount) : null,
        // true = số tiền lấy từ tổng Còn chi của bảng nguồn lúc duyệt.
        amountFromManagementExpense: autoAmount,
        cashflowSource: source,
        ...(cashflowAmounts ? { cashflowTable: table } : {}),
        // Trường nào được duyệt / không duyệt (chỉ khi hệ thống lập lệnh chi).
        ...(decided.length > 0 ? { items: decided } : {}),
        paymentOrder: paymentOrder
          ? {
              code: paymentOrder.code,
              amount: Number(paymentOrder.amount),
              paymentMethod: paymentOrder.paymentMethod,
            }
          : null,
        ...managementSnapshot,
      }),
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: `✅ ${this.monthlyKindLabel(saved)} đã duyệt`,
        message:
          `Đề xuất ${saved.code} đã được Giám đốc duyệt, vui lòng xuất tiền` +
          (decided.some((item) => !item.approved)
            ? `. Không duyệt: ${decided
                .filter((item) => !item.approved)
                .map((item) => item.label)
                .join('; ')}`
            : ''),
        senderId: user.id,
        meta: {
          status: saved.status,
          paymentOrderId: (paymentOrder as SuggestPaymentOrder | null)?.id,
        },
      },
      {
        roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  async rejectExpense(id: number, user: AuthUser, reason: string) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }
    const managementSnapshot = await this.managementExpenseSnapshot(existing);
    const saved = await this.expenseTransition({
      id,
      action: existing.isMonthlyExpense
        ? ExpenseAction.REJECT_MONTHLY
        : ExpenseAction.REJECT,
      user,
      note: reason,
      logData: () => managementSnapshot,
      mutate: (s) => {
        s.approvedBy = user.id;
        s.approvedAt = new Date();
        s.rejectReason = reason;
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '❌ Đề xuất chi bị từ chối',
        message: `Đề xuất ${saved.code} đã bị ${this.expenseApproverLabel(user)} từ chối: ${reason}`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        // Người còn lại trong nhóm giữ chốt duyệt vẫn cần biết kết quả.
        roles: existing.isMonthlyExpense
          ? [ExpenseRole.DIRECTOR]
          : [
              ExpenseRole.DIRECTOR,
              ExpenseRole.SALES_ADMIN,
              ExpenseRole.CHIEF_ACCOUNTANT,
            ],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /**
   * Chủ đề xuất tự rút đơn khi chưa được duyệt.
   *
   * Cần action riêng vì `REJECT` đã cấm chủ đề xuất, nên sau khi siết phân tách
   * nhiệm vụ thì người tạo không còn cách nào tự huỷ đơn của mình.
   */
  async withdrawExpense(id: number, user: AuthUser, reason?: string) {
    const before = await this.repo.findOne({ where: { id } });
    const waitingAt = before
      ? expenseActorForStatus(
          before.status as SuggestStatus,
          before.requestKind ?? ExpenseRequestKind.CASH,
          before.equipmentSource,
          before.isMonthlyExpense,
          before.approvalFlow,
        )
      : null;
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.WITHDRAW,
      user,
      note: reason,
    });

    // Giám đốc rút hộ (overrideRoles) khác với chủ đơn tự rút — câu chữ và
    // người nhận thông báo phải phản ánh đúng ai vừa làm việc này.
    const withdrawnByOwner = saved.createdBy === user.id;

    // Báo cho những người đang chờ xử lý đơn này để họ khỏi mở ra rồi mới biết.
    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '↩️ Đề xuất chi đã được rút',
        message:
          (withdrawnByOwner
            ? `Đề xuất ${saved.code} đã được người tạo rút lại`
            : `Đề xuất ${saved.code} đã bị Giám đốc rút`) +
          (reason ? `: ${reason}` : ''),
        senderId: user.id,
        meta: { status: saved.status, reason: reason ?? null },
      },
      {
        // Người đang giữ bước (Kế toán / Kế toán trưởng / Giám đốc...).
        roles:
          waitingAt && !waitingAt.owner && waitingAt.roles.length
            ? waitingAt.roles
            : [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        // Chủ đơn không tự biết như khi chính họ rút — phải báo riêng cho họ.
        userIds: !withdrawnByOwner && saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /**
   * Chủ đề xuất (kinh doanh) sửa đề xuất — sửa được ở mọi trạng thái, kể cả
   * đã duyệt/đã lên lệnh chi/xuất kho. Sửa xong mà đề xuất không còn ở
   * PENDING_APPROVAL thì coi như nội dung đã chốt trước đó không còn đúng
   * nữa, nên quay lại PENDING_APPROVAL và xoá dấu duyệt (kể cả kiểm duyệt của
   * Sales Admin) để duyệt lại từ đầu. Chứng từ/tiến độ đã phát sinh (lệnh
   * chi, phiếu xuất kho, mốc đã chi/đã nhận...) không bị xoá — chỉ trạng thái
   * duyệt được đưa về ban đầu.
   */
  async updateExpense(
    id: number,
    dto: UpdateExpenseRequestDto,
    fileUrl: string | undefined,
    user: AuthUser,
  ) {
    const actor = this.ensureUser(user);
    const saved = await this.dataSource.transaction(async (manager) => {
      const suggest = await manager.findOne(Suggest, { where: { id } });

      if (!suggest || suggest.type !== SuggestType.EXPENSE_REQUEST) {
        throw new NotFoundException('Đề xuất chi không tồn tại');
      }
      if (suggest.createdBy !== actor.id) {
        throw new ForbiddenException('Chỉ người tạo mới được sửa đề xuất');
      }
      // Thiết bị từ nhà cung cấp đã nhập kho thật: duyệt lại sẽ khiến người xử
      // lý nhập kho lần nữa, tồn kho bị cộng hai lần.
      if (
        suggest.equipmentSource === EquipmentSource.SUPPLIER &&
        [SuggestStatus.STOCK_IN_COMPLETED, SuggestStatus.SPENT].includes(
          suggest.status as SuggestStatus,
        )
      ) {
        throw new BadRequestException(
          'Thiết bị của đề xuất này đã nhập kho nên không sửa được nữa',
        );
      }
      // Tiền chi tháng đã xuất mà chưa hoàn quỹ thì lệnh chi đang là căn cứ của
      // sổ quỹ: sửa ở đây sẽ xoá lệnh chi đó. Muốn đổi số tiền thì Kế toán công
      // nợ sửa lệnh chi để Giám đốc duyệt lại.
      if (
        suggest.isMonthlyExpense &&
        [
          SuggestStatus.CASH_RELEASED,
          SuggestStatus.CASH_RECEIVED,
          SuggestStatus.SPENT,
          SuggestStatus.NOT_SPENT,
          SuggestStatus.PARTIALLY_SPENT,
        ].includes(suggest.status as SuggestStatus)
      ) {
        throw new BadRequestException(
          'Đề xuất chi tháng đã xuất tiền nên không sửa được. Cần đổi số tiền thì nhờ Kế toán công nợ sửa lệnh chi',
        );
      }

      // Gộp giá trị mới lên giá trị cũ rồi kiểm tra như lúc tạo — sửa xong
      // đề xuất vẫn phải là một đề xuất hợp lệ.
      const content = dto.content ?? suggest.content;
      const expectedPaymentDate =
        dto.expectedPaymentDate ?? suggest.expectedPaymentDate;
      if (!content?.trim()) {
        throw new BadRequestException('Thiếu tiêu đề/nội dung đề xuất');
      }
      if (!expectedPaymentDate) {
        throw new BadRequestException('Thiếu ngày dự kiến chi');
      }
      // Chỉ siết "từ hôm nay" khi người dùng thật sự đổi ngày — đề xuất cũ có
      // ngày đã qua vẫn phải sửa được các trường khác.
      if (dto.expectedPaymentDate && dto.expectedPaymentDate < vnToday()) {
        throw new BadRequestException(
          'Ngày dự kiến chi phải từ hôm nay trở đi',
        );
      }

      // Đổi trường ⇄ xã/phường: gửi cái nào thì chuyển sang cái đó, cái kia xoá.
      // Năm học mặc định theo kỳ hiện tại nhưng vẫn chọn lại được — trường có
      // thể chỉ có môn học khai báo cho năm khác.
      const changesSchool = dto.schoolId !== undefined && dto.schoolId !== null;
      const changesWard = dto.wardId !== undefined && dto.wardId !== null;
      let schoolId = suggest.schoolId ?? null;
      let schoolYear = dto.schoolYear ?? suggest.schoolYear ?? null;
      let wardId = suggest.wardId ?? null;
      let isMonthlyExpense =
        dto.isMonthlyExpense ?? suggest.isMonthlyExpense ?? false;
      let subjectId: number | null = null;
      let expensePeriodId: number | null = null;
      let policySelections: PolicySupportSelection[] = [];

      // Có đủ định danh liên kết thì tự nhận diện đề xuất chi tháng, giúp các
      // client cũ không cần gửi thêm cờ isMonthlyExpense.
      if (
        dto.cashflowSource !== undefined ||
        dto.subjectId !== undefined ||
        dto.expensePeriodId !== undefined ||
        dto.monthlyItems !== undefined
      ) {
        isMonthlyExpense = true;
      }
      if (dto.cashflowItems !== undefined) isMonthlyExpense = true;
      let cashflowSource: CashflowSource =
        dto.cashflowSource ?? cashflowSourceOf(suggest) ?? 'MANAGEMENT';
      const deductPolicy = isMonthlyExpense
        ? dto.deductPolicy ?? suggest.deductPolicy ?? false
        : dto.deductPolicy ?? suggest.deductPolicy ?? true;
      // "Đề xuất chi tháng" tích chọn: gửi khoản mới, hoặc sửa đơn tích chọn
      // mà không gửi lại khoản (giữ khoản cũ, kiểm lại với bảng hiện tại).
      const salesPick =
        isMonthlyExpense &&
        (dto.cashflowItems !== undefined ||
          (isSalesPick(suggest) &&
            dto.cashflowSource === undefined &&
            dto.monthlyItems === undefined));
      let salesPickResolved: Awaited<
        ReturnType<SuggestService['resolveSalesPick']>
      > | null = null;

      if (salesPick) {
        const stored = dto.cashflowItems
          ? null
          : await manager.find(SuggestMonthlyItem, {
              where: { suggestId: suggest.id! },
              order: { position: 'ASC', id: 'ASC' },
            });
        salesPickResolved = await this.resolveSalesPick(
          manager,
          actor,
          {
            schoolId: dto.schoolId ?? suggest.schoolId ?? null,
            expensePeriodId: dto.expensePeriodId ?? suggest.expensePeriodId ?? null,
            schoolYear: dto.schoolYear ?? null,
            items:
              dto.cashflowItems ??
              (stored ?? []).map((row) => ({
                source: itemSourceOf(row, suggest),
                subjectId: row.subjectId ?? undefined,
                schoolTeacherId: row.schoolTeacherId ?? undefined,
              })),
            salesAmount: dto.salesAmount ?? suggest.salesAmount ?? null,
          },
          suggest.id!,
        );
        schoolId = salesPickResolved.school.id!;
        schoolYear = salesPickResolved.schoolYear;
        expensePeriodId = salesPickResolved.period.id;
        cashflowSource = salesPickResolved.picks[0].source;
        subjectId = null;
        wardId = null;
      } else if (isMonthlyExpense) {
        // Sửa xong luôn đi quy trình Kế toán (kể cả đề xuất chi tháng cũ):
        // một trường + một kỳ, Kế toán nhập số liệu lại từ đầu.
        const sheetInput = this.chainSheetInput({
          schoolId: dto.schoolId ?? suggest.schoolId ?? null,
          expensePeriodId: dto.expensePeriodId ?? suggest.expensePeriodId ?? null,
          monthlyItems: dto.monthlyItems,
        });
        const sheet = await this.resolveChainSheet(
          manager,
          actor,
          cashflowSource,
          {
            schoolId: sheetInput.schoolId,
            expensePeriodId: sheetInput.expensePeriodId,
            schoolYear: dto.schoolYear ?? null,
          },
          suggest.id!,
        );
        schoolId = sheet.school.id!;
        schoolYear = sheet.schoolYear;
        expensePeriodId = sheet.period.id;
        subjectId = null;
        wardId = null;
      } else if (changesSchool) {
        schoolId = dto.schoolId!;
        wardId = null;
        schoolYear = dto.schoolYear ?? currentSchoolYear();
      } else if (changesWard) {
        wardId = dto.wardId!;
        schoolId = null;
        schoolYear = null;
      }

      if (!isMonthlyExpense && schoolId) {
        const school = await manager.findOne(School, { where: { id: schoolId } });
        if (!school) throw new BadRequestException('Trường không tồn tại');
        if (!schoolYear) throw new BadRequestException('Thiếu năm học');
        if (!isValidSchoolYear(schoolYear)) {
          throw new BadRequestException('Năm học không hợp lệ');
        }
        const subjectCount = await manager.count(Subject, {
          where: { schoolId, schoolYear },
        });
        if (subjectCount === 0) {
          throw new BadRequestException(
            'Trường không có môn học trong năm học đã chọn',
          );
        }
        if (deductPolicy) {
          await this.assertPolicyHasSupport(manager, school, schoolYear);
          // Không gửi lại danh sách thì kiểm lại các dòng đang có với trường/năm học mới.
          policySelections = await this.resolvePolicySupportSelections(
            manager,
            school,
            schoolYear,
            dto.policySupportItems ??
              (await this.storedPolicySupportInput(manager, suggest.id!)),
            suggest.id!,
          );
        }
      } else if (!isMonthlyExpense && wardId) {
        const ward = await manager.findOne(Ward, { where: { id: wardId } });
        if (!ward) throw new BadRequestException('Xã/phường không tồn tại');
      } else if (!isMonthlyExpense) {
        throw new BadRequestException('Thiếu xã/phường');
      }

      const fromStatus = suggest.status;
      const wasMonthlyExpense = suggest.isMonthlyExpense ?? false;
      // Chi Năm về chờ Giám đốc duyệt; chi tháng về chờ Kế toán nhập số liệu.
      const targetStatus = isMonthlyExpense
        ? SuggestStatus.PENDING_ACCOUNTANT
        : SuggestStatus.PENDING_APPROVAL;
      const needsReapproval = fromStatus !== targetStatus;

      suggest.content = content;
      if (dto.description !== undefined) suggest.description = dto.description;
      if (dto.participants !== undefined) suggest.participants = dto.participants;
      if (dto.beneficiaryInfo !== undefined) {
        suggest.beneficiaryInfo = dto.beneficiaryInfo;
      }
      suggest.deductPolicy = deductPolicy;
      suggest.expectedPaymentDate = expectedPaymentDate;
      suggest.schoolId = schoolId;
      suggest.schoolYear = schoolYear;
      suggest.wardId = wardId;
      suggest.isMonthlyExpense = isMonthlyExpense;
      suggest.cashflowSource = isMonthlyExpense ? cashflowSource : null;
      suggest.approvalFlow = salesPick
        ? SALES_PICK
        : isMonthlyExpense
          ? ACCOUNTANT_CHAIN
          : null;
      suggest.salesAmount = salesPickResolved?.salesAmount ?? null;
      suggest.subjectId = subjectId;
      suggest.expensePeriodId = expensePeriodId;
      if (fileUrl) suggest.fileUrl = fileUrl;
      suggest.version = (suggest.version ?? 1) + 1;
      // Chi tháng luôn là tiền; số tiền tính lại lúc Giám đốc duyệt. Chi Năm
      // giữ cách cũ: người duyệt chốt loại đề xuất.
      suggest.requestKind = isMonthlyExpense ? ExpenseRequestKind.CASH : null;
      if (wasMonthlyExpense || isMonthlyExpense) suggest.amount = null;
      suggest.assignedTechnicianId = null;
      suggest.equipmentSource = null;
      suggest.stockInHandlerId = null;
      suggest.acceptorId = null;

      if (needsReapproval) {
        suggest.status = targetStatus;
        // TypeORM bỏ qua undefined: chi tháng phải gán null mới xoá được người
        // duyệt của vòng trước.
        suggest.approvedBy = isMonthlyExpense ? null : undefined;
        suggest.approvedAt = null;
        suggest.rejectReason = null;
        suggest.saleadminReviewStatus = null;
        suggest.saleadminNote = null;
        suggest.saleadminReviewedBy = null;
        suggest.saleadminReviewedAt = null;
      }

      const s = await manager.save(suggest);
      // Người được giao của vòng duyệt cũ không còn giá trị — duyệt lại sẽ
      // giao việc lại từ đầu.
      await manager.delete(SuggestAssignment, { suggestId: s.id! });
      // Số tiền/lệnh chi cũ không còn hiệu lực khi nội dung chi tháng bị sửa
      // hoặc khi đổi qua lại giữa chi tháng và chi Năm.
      // Chi tháng: khoản + số tiền chốt lại khi Kế toán gửi.
      if (wasMonthlyExpense || isMonthlyExpense) {
        await manager.delete(SuggestPaymentOrder, { suggestId: s.id! });
        await manager.delete(SuggestMonthlyItem, { suggestId: s.id! });
      }
      if (salesPickResolved) {
        await this.saveSalesPickItems(manager, s.id!, salesPickResolved.picks);
      }
      // Dòng chính sách đã tích: thay bằng danh sách vừa kiểm (Đã chi ghi lại
      // khi đề xuất hoàn thành lần nữa). Phường/xã, chi tháng: không có dòng.
      await this.savePolicySupportSelections(manager, s.id!, policySelections);

      if (fileUrl) {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          [{ fileUrl, fileName: fileUrl.split('/').pop() || 'file' }],
          actor.id,
          ExpenseAction.UPDATE,
        );
      }

      await this.writeExpenseLog(manager, {
        suggestId: s.id!,
        userId: actor.id,
        action: ExpenseAction.UPDATE,
        fromStatus,
        toStatus: s.status,
        note: needsReapproval ? 'Sửa sau khi đã duyệt — cần duyệt lại' : null,
        details: {
          ...(salesPickResolved ? this.salesPickLog(salesPickResolved) : {}),
          ...(await this.expenseNextStepDetails(manager, s)),
        },
      });

      return { s, needsReapproval };
    });

    await this.notifyExpense(
      {
        suggestId: saved.s.id!,
        title: saved.s.isMonthlyExpense
          ? `🔁 ${this.monthlyKindLabel(saved.s)} cần Kế toán nhập ${isSalesPick(saved.s) ? 'số tiền' : 'số liệu'} lại`
          : saved.needsReapproval
            ? '🔁 Đề xuất chi cần duyệt lại'
            : '✏️ Đề xuất chi đã được sửa',
        message: saved.s.isMonthlyExpense
          ? `${this.monthlyKindLabel(saved.s)} ${saved.s.code} đã được sửa, cần nhập số liệu và gửi lại: ${saved.s.content}`
          : saved.needsReapproval
            ? `Đề xuất ${saved.s.code} đã được sửa sau khi duyệt, cần duyệt lại: ${saved.s.content}`
            : `Đề xuất ${saved.s.code} đang chờ duyệt vừa được sửa: ${saved.s.content}`,
        senderId: actor.id,
        meta: { status: saved.s.status, reapproval: saved.needsReapproval },
      },
      {
        roles: saved.s.isMonthlyExpense
          ? isSalesPick(saved.s)
            ? [ExpenseRole.ACCOUNTANT, ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT]
            : [ExpenseRole.ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT]
          : [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
      },
    );

    return this.findOneExpense(saved.s.id!);
  }

  /**
   * Giám đốc xoá hẳn một đề xuất chi. Khác `withdrawExpense` (chuyển trạng
   * thái, giữ lại audit trail): đây là xoá cứng khỏi DB, chỉ cho phép khi
   * tiền chưa phát sinh (chưa lên lệnh chi/xuất quỹ) để không phá vỡ lịch sử
   * dòng tiền đã thực hiện.
   */
  async deleteExpense(id: number, user: AuthUser) {
    const suggest = await this.repo.findOne({ where: { id } });

    if (!suggest) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }

    if (suggest.type !== SuggestType.EXPENSE_REQUEST) {
      throw new BadRequestException('Đề xuất này không phải luồng đề xuất chi');
    }

    // Đã phát sinh dòng tiền (nhánh tiền) hoặc đã xuất kho (nhánh thiết bị)
    // thì không xoá được — lịch sử tiền/hàng đã thực hiện phải giữ nguyên.
    const RESOURCE_MOVED_STATUSES: SuggestStatus[] = [
      SuggestStatus.PAYMENT_ORDERED,
      SuggestStatus.CASH_RELEASED,
      SuggestStatus.CASH_RECEIVED,
      SuggestStatus.SPENT,
      SuggestStatus.NOT_SPENT,
      SuggestStatus.PARTIALLY_SPENT,
      SuggestStatus.FUND_RETURNED,
      SuggestStatus.STOCK_ISSUE_ORDERED,
      SuggestStatus.EQUIPMENT_RECEIVED,
      SuggestStatus.EQUIPMENT_RETURNED,
      SuggestStatus.STOCK_IN_COMPLETED,
    ];

    if (suggest.status && RESOURCE_MOVED_STATUSES.includes(suggest.status)) {
      throw new BadRequestException(
        'Không thể xoá đề xuất đã phát sinh dòng tiền/xuất nhập kho ' +
          '(đã lên lệnh chi, xuất quỹ, lên lệnh xuất kho hoặc nhập kho)',
      );
    }

    const { code, createdBy, status } = suggest;

    // Báo cho người tạo trước khi xoá — sau khi xoá, `notifyExpense` sẽ không
    // còn tra được thông tin đề xuất để gắn vào meta.
    if (createdBy && createdBy !== user.id) {
      await this.notifyExpense(
        {
          suggestId: id,
          title: '🗑️ Đề xuất chi đã bị xoá',
          message: `Đề xuất ${code} đã bị Giám đốc xoá`,
          senderId: user.id,
          meta: { status },
        },
        { userIds: [createdBy] },
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SuggestHistory, { suggestId: id });
      await manager.remove(Suggest, suggest);
    });

    return { message: 'Đã xoá đề xuất chi' };
  }

  // ================= BƯỚC 3 — KẾ TOÁN CÔNG NỢ lên lệnh chi =================

  async createExpensePaymentOrder(
    id: number,
    dto: CreatePaymentOrderDto,
    user: AuthUser,
  ) {
    const existing = await this.repo.findOne({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }
    let paymentOrder: SuggestPaymentOrder | null = null;
    // Quy trình Kế toán: lệnh chi đúng số Giám đốc duyệt, giữ phần từng khoản
    // để ghi ngược QL thu chi / chi một phần như lệnh chi hệ thống lập.
    const chain = isMonthlyChain(existing);
    let amount = dto.amount;

    const saved = await this.expenseTransition({
      id,
      action:
        existing.isMonthlyExpense && !chain
          ? ExpenseAction.CREATE_MONTHLY_PAYMENT_ORDER
          : ExpenseAction.CREATE_PAYMENT_ORDER,
      user,
      note: dto.note,
      logData: () => ({
        paymentOrder: {
          code: (paymentOrder as SuggestPaymentOrder | null)?.code ?? null,
          amount,
          paymentMethod: dto.paymentMethod,
        },
      }),
      mutate: (s) => {
        if (s.isMonthlyExpense && !chain) s.amount = dto.amount;
        // Một đề xuất có thể được chi lại sau khi đã hoàn quỹ.
        // Xóa dấu vết trạng thái của vòng chi trước trước khi mở vòng mới.
        s.cashReleasedBy = null;
        s.cashReleasedAt = null;
        s.cashReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.fundReturnedBy = null;
        s.fundReturnedAt = null;
      },
      extra: async (manager, s) => {
        const code = await this.generateCode(
          manager,
          'suggest_payment_order',
          'code',
          'LC',
        );

        // Quan hệ hiện tại là 1-1: thay lệnh chi của vòng đã hoàn quỹ
        // bằng lệnh mới, còn lịch sử chuyển trạng thái vẫn được giữ.
        await manager.delete(SuggestPaymentOrder, {
          suggestId: s.id!,
        });
        if (chain) {
          amount = await this.chainApprovedTotal(manager, s.id!);
          await manager.update(SuggestMonthlyItem, { suggestId: s.id! }, { spent: null });
        } else if (s.isMonthlyExpense) {
          await this.clearMonthlyItemSplit(manager, s.id!);
        }

        paymentOrder = await manager.save(SuggestPaymentOrder, {
          code,
          suggestId: s.id!,
          amount,
          paymentMethod: dto.paymentMethod,
          note: dto.note ?? null,
          createdBy: user.id,
        });
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: saved.isMonthlyExpense && !chain
          ? '📋 Đề xuất chi tháng chờ duyệt'
          : '🧾 Lệnh chi mới',
        message: saved.isMonthlyExpense && !chain
          ? `Kế toán công nợ đã nhập số tiền cho đề xuất ${saved.code}, vui lòng duyệt`
          : `Lệnh chi ${(paymentOrder as SuggestPaymentOrder | null)?.code} đã được lập` +
            ` cho đề xuất ${saved.code}, vui lòng xuất tiền và chọn nguồn tiền`,
        senderId: user.id,
        meta: {
          status: saved.status,
          paymentOrderId: (paymentOrder as SuggestPaymentOrder | null)?.id,
        },
      },
      {
        roles: saved.isMonthlyExpense && !chain
          ? [ExpenseRole.DIRECTOR]
          : [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
      },
    );

    return { suggest: saved, paymentOrder };
  }

  /**
   * Kế toán công nợ sửa lệnh chi đã lập. Cho phép sửa kể cả khi thủ quỹ đã
   * xuất tiền hoặc kinh doanh đã nhận tiền — quay đề xuất về `PAYMENT_ORDERED`
   * và xoá dấu vết các bước sau (giống hệt cách `createExpensePaymentOrder`
   * xử lý khi lập lại lệnh chi sau hoàn quỹ) để buộc thủ quỹ xuất tiền lại và
   * kinh doanh xác nhận nhận tiền lại theo số liệu mới.
   */
  async editExpensePaymentOrder(
    id: number,
    dto: CreatePaymentOrderDto,
    user: AuthUser,
  ) {
    const request = await this.repo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }
    let paymentOrder: SuggestPaymentOrder | null = null;
    // Quy trình Kế toán: chỉ sửa hình thức / ghi chú, số tiền giữ đúng số
    // Giám đốc duyệt. Đã chi thì QL thu chi đã ghi theo lệnh chi — không sửa.
    const chain = isMonthlyChain(request);
    if (chain && request.status === SuggestStatus.SPENT) {
      throw new BadRequestException(
        'Đề xuất đã chi và đã ghi về QL thu chi nên không sửa lệnh chi được',
      );
    }
    let amount = dto.amount;

    const saved = await this.expenseTransition({
      id,
      action:
        request.isMonthlyExpense && !chain
          ? ExpenseAction.EDIT_MONTHLY_PAYMENT_ORDER
          : ExpenseAction.EDIT_PAYMENT_ORDER,
      user,
      note: dto.note,
      logData: () => ({
        paymentOrder: {
          code: (paymentOrder as SuggestPaymentOrder | null)?.code ?? null,
          amount,
          paymentMethod: dto.paymentMethod,
        },
      }),
      mutate: (s) => {
        if (s.isMonthlyExpense && !chain) {
          s.amount = dto.amount;
          s.approvedBy = null;
          s.approvedAt = null;
        }
        s.cashReleasedBy = null;
        s.cashReleasedAt = null;
        s.cashReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.fundReturnedBy = null;
        s.fundReturnedAt = null;
      },
      extra: async (manager, s) => {
        const existing = await manager.findOne(SuggestPaymentOrder, {
          where: { suggestId: s.id! },
        });
        // Chi tháng mới chờ Giám đốc chưa có lệnh chi: số tiền do hệ thống
        // lập lúc duyệt, không có gì để sửa.
        if (!existing) {
          throw new BadRequestException('Đề xuất chưa có lệnh chi để sửa');
        }
        if (chain) {
          amount = await this.chainApprovedTotal(manager, s.id!);
          await manager.update(SuggestMonthlyItem, { suggestId: s.id! }, { spent: null });
        } else if (s.isMonthlyExpense) {
          await this.clearMonthlyItemSplit(manager, s.id!);
        } else {
          // Chi Năm sửa lệnh chi sau khi đã chi: Đã chi của dòng chính sách ghi lại khi chi lần nữa.
          await manager.update(
            SuggestPolicySupportItem,
            { suggestId: s.id! },
            { spentAmount: null, spentAt: null },
          );
        }

        paymentOrder = await manager.save(SuggestPaymentOrder, {
          ...(existing ?? {}),
          suggestId: s.id!,
          amount,
          paymentMethod: dto.paymentMethod,
          note: dto.note ?? null,
          // Nguồn tiền do thủ quỹ chọn lại khi xuất tiền lần này.
          fundSource: null,
          cashAccount: null,
        });
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: saved.isMonthlyExpense && !chain
          ? '📋 Số tiền chi tháng đã được sửa'
          : '✏️ Lệnh chi đã được sửa',
        message: saved.isMonthlyExpense && !chain
          ? `Số tiền của đề xuất ${saved.code} vừa được Kế toán công nợ sửa, vui lòng duyệt lại`
          : `Lệnh chi ${(paymentOrder as SuggestPaymentOrder | null)?.code} của đề xuất ${saved.code}` +
            ` vừa được kế toán công nợ sửa lại, vui lòng xuất tiền lại theo số liệu mới`,
        senderId: user.id,
        meta: {
          status: saved.status,
          paymentOrderId: (paymentOrder as SuggestPaymentOrder | null)?.id,
        },
      },
      {
        roles: saved.isMonthlyExpense && !chain
          ? [ExpenseRole.DIRECTOR]
          : [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
      },
    );

    return { suggest: saved, paymentOrder };
  }

  // ================= BƯỚC 4 — THỦ QUỸ xác nhận đã xuất tiền =================

  async confirmCashReleased(
    id: number,
    user: AuthUser,
    note?: string,
    files?: UploadedAttachment[],
    fundSource?: FundSource,
    cashAccount?: string,
    cashSplitsInput?: { cashAccount: string; amount: number }[],
  ) {
    const multi = Array.isArray(cashSplitsInput) && cashSplitsInput.length > 0;
    if (!multi && !cashAccount && !fundSource) {
      throw new BadRequestException('Vui lòng chọn nguồn chi');
    }
    // Nhiều nguồn chi (19/11/2026): nguồn đầu tiên là tài khoản chính của lệnh chi.
    let splits: CashSplit[] = [];
    let primaryAccount: string | null = multi
      ? String(cashSplitsInput![0]?.cashAccount ?? '') || null
      : cashAccount ?? null;
    // Nguồn chi (tài khoản) quyết định nhóm nguồn tiền; client cũ chỉ gửi nhóm.
    let source = primaryAccount ? fundSourceOfCashAccount(primaryAccount) : fundSource!;
    let sourceLabel = primaryAccount
      ? cashAccountLabel(primaryAccount)
      : FUND_SOURCE_LABEL[source];

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_CASH_RELEASED,
      user,
      note,
      logData: () => ({
        fundSource: source,
        cashAccount: primaryAccount,
        // Sổ quỹ ghi mỗi nguồn một bút toán chi.
        ...(splits.length > 1 ? { cashSplits: splits } : {}),
      }),
      mutate: (s) => {
        s.cashReleasedBy = user.id;
        s.cashReleasedAt = new Date();
      },
      extra: async (manager, s) => {
        if (multi) {
          const order = await manager.findOne(SuggestPaymentOrder, {
            where: { suggestId: s.id! },
          });
          if (!order) throw new BadRequestException('Đề xuất chưa có lệnh chi');
          splits = normalizeCashSplits(cashSplitsInput, Number(order.amount));
        }
        if (splits.length) {
          primaryAccount = splits[0].cashAccount;
          source = fundSourceOfCashAccount(primaryAccount);
          sourceLabel = cashSplitsLabel(splits);
        }
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          files,
          user.id,
          ExpenseAction.CONFIRM_CASH_RELEASED,
        );
        await manager.update(
          SuggestPaymentOrder,
          { suggestId: s.id! },
          {
            fundSource: source,
            cashAccount: primaryAccount,
            cashSplits: splits.length > 1 ? splits : null,
            // Chi tháng không còn bước Kế toán chọn hình thức: hình thức đi
            // theo tài khoản Thủ quỹ xuất (111x tiền mặt, 112x ngân hàng).
            ...(s.isMonthlyExpense
              ? {
                  paymentMethod:
                    source === FundSource.BANK_ACCOUNT
                      ? PaymentMethod.BANK_TRANSFER
                      : PaymentMethod.CASH,
                }
              : {}),
          },
        );
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '💵 Thủ quỹ đã xuất tiền',
        message:
          `Thủ quỹ đã xuất tiền cho đề xuất ${saved.code} từ ${sourceLabel},` +
          ` vui lòng xác nhận nhận tiền`,
        senderId: user.id,
        meta: {
          status: saved.status,
          fundSource: source,
          cashAccount: primaryAccount,
          ...(splits.length > 1 ? { cashSplits: splits } : {}),
        },
      },
      { userIds: saved.createdBy ? [saved.createdBy] : [] },
    );

    return saved;
  }

  /**
   * Xoá 1 tệp đính kèm — dùng ở form "Xác nhận xuất tiền" để thủ quỹ gỡ
   * chứng từ đã up nhầm trước khi nộp. Chỉ người đã up hoặc kế toán trưởng
   * (giám sát chung) được xoá, tránh xoá nhầm tệp của người khác.
   */
  async deleteExpenseAttachment(
    id: number,
    attachmentId: number,
    user: AuthUser,
  ) {
    const attachment = await this.attachmentRepo.findOne({
      where: { id: attachmentId, suggestId: id },
    });
    if (!attachment) {
      throw new NotFoundException('Tệp đính kèm không tồn tại');
    }
    if (
      attachment.uploadedBy !== user.id &&
      !user.roles?.includes(ExpenseRole.CHIEF_ACCOUNTANT)
    ) {
      throw new ForbiddenException('Chỉ người đã tải lên mới được xoá tệp này');
    }

    await this.attachmentRepo.delete({ id: attachmentId });
    return { success: true };
  }

  // ================= BƯỚC 5 — SALES xác nhận đã nhận tiền =================

  async confirmCashReceived(id: number, user: AuthUser, note?: string) {
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_CASH_RECEIVED,
      user,
      note,
      mutate: (s) => {
        s.cashReceivedAt = new Date();
      },
    });
  }

  // ================= BƯỚC 6A — SALES xác nhận đã chi =================

  async confirmSpent(
    id: number,
    user: AuthUser,
    note?: string,
    files?: UploadedAttachment[],
  ) {
    let synced: Record<string, unknown> = {};
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_SPENT,
      user,
      note,
      mutate: (s) => {
        s.spentAt = new Date();
      },
      extra: async (manager, s) => {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          files,
          user.id,
          ExpenseAction.CONFIRM_SPENT,
        );
        if (s.isMonthlyExpense) {
          const rows = (await this.loadMonthlyRows(manager, s.id!)).filter(
            (row) => !row.excluded,
          );
          synced = await this.recordCashflowPayments(manager, s, rows);
        } else {
          synced = await this.recordPolicySupportSpent(manager, s.id!);
        }
      },
      logData: () => synced,
    });
  }

  // ================= BƯỚC 6B — SALES xác nhận chưa chi =================

  async confirmNotSpent(id: number, user: AuthUser, reason: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_NOT_SPENT,
      user,
      note: reason,
      mutate: (s) => {
        s.notSpentReason = reason;
      },
    });

    const isEquipment = saved.requestKind === ExpenseRequestKind.EQUIPMENT;

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: isEquipment ? '↩️ Nhập lại kho thiết bị' : '↩️ Hoàn tiền về quỹ',
        message: isEquipment
          ? `Kinh doanh chưa dùng thiết bị của đề xuất ${saved.code}, sẽ trả lại kho,` +
            ` vui lòng xác nhận khi nhận lại`
          : `Kinh doanh chưa chi đề xuất ${saved.code}, sẽ hoàn tiền về quỹ,` +
            ` vui lòng xác nhận khi nhận lại`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        roles: isEquipment
          ? [ExpenseRole.TECHNICAL]
          : [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT],
      },
    );

    return saved;
  }

  // ========== BƯỚC 6C — SALES chi một phần (chi tháng nhiều trường) ==========

  /**
   * Kinh doanh chọn trường đã chi thật; không nhập số. Số đã chi = phần của
   * các trường đó lúc Giám đốc duyệt, phần dư chờ Thủ quỹ nhận lại.
   */
  async confirmPartiallySpent(
    id: number,
    user: AuthUser,
    spentItemIds: number[],
    reason: string,
    files?: UploadedAttachment[],
  ) {
    type PartialSummary = {
      spentAmount: number;
      returnAmount: number;
      items: { id: number; label: string; amount: number | null; spent: boolean }[];
    };
    let summary: PartialSummary | null = null;
    let synced: Record<string, unknown> = {};

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_PARTIALLY_SPENT,
      user,
      note: reason,
      mutate: (s) => {
        s.spentAt = new Date();
        s.notSpentReason = reason;
      },
      extra: async (manager, s) => {
        if (!s.isMonthlyExpense) {
          throw new BadRequestException(
            'Chỉ đề xuất chi tháng nhiều trường mới chi một phần được',
          );
        }
        // Trường Giám đốc không duyệt không có trong lệnh chi.
        const rows = (await this.loadMonthlyRows(manager, s.id!)).filter(
          (row) => !row.excluded,
        );
        const order = await manager.findOne(SuggestPaymentOrder, {
          where: { suggestId: s.id! },
        });
        if (!order) throw new BadRequestException('Đề xuất chưa có lệnh chi');
        const result = partialSpendSummary(rows, Number(order.amount), spentItemIds);
        const chosen = new Set(spentItemIds);
        for (const row of rows) {
          await manager.update(
            SuggestMonthlyItem,
            { id: row.id },
            { spent: chosen.has(row.id) },
          );
        }
        synced = await this.recordCashflowPayments(
          manager,
          s,
          rows.filter((row) => chosen.has(row.id)),
        );
        summary = {
          ...result,
          items: rows.map((row) => ({
            id: row.id,
            label: monthlyItemLabel(row),
            amount: row.approvedAmount,
            spent: chosen.has(row.id),
          })),
        };
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          files,
          user.id,
          ExpenseAction.CONFIRM_PARTIALLY_SPENT,
        );
      },
      logData: () => ({ partialSpend: summary, ...synced }),
    });

    // Gán trong callback nên TypeScript tưởng vẫn là null.
    const done = summary as PartialSummary | null;
    if (done) {
      const spentCount = done.items.filter((item) => item.spent).length;
      await this.notifyExpense(
        {
          suggestId: saved.id!,
          title: '↩️ Nhận lại phần dư',
          message:
            `Kinh doanh đã chi ${spentCount}/${done.items.length} trường của đề xuất ${saved.code},` +
            ` vui lòng nhận lại phần dư ${formatMoneyVnd(done.returnAmount)} đ`,
          senderId: user.id,
          meta: { status: saved.status, returnAmount: done.returnAmount },
        },
        { roles: [ExpenseRole.TREASURER, ExpenseRole.CHIEF_ACCOUNTANT] },
      );
    }

    return saved;
  }

  /** Thủ quỹ nhận lại phần dư của lần chi một phần — đề xuất thành Đã chi. */
  async confirmRemainderReturned(id: number, user: AuthUser, note?: string) {
    let returnAmount: number | null = null;
    let cashAccount: string | null = null;
    let returnSplits: CashSplit[] | null = null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_REMAINDER_RETURNED,
      user,
      note,
      extra: async (manager, s) => {
        const rows = (
          await manager.find(SuggestMonthlyItem, {
            where: { suggestId: s.id! },
          })
        ).filter((row) => !row.excluded);
        const order = await manager.findOne(SuggestPaymentOrder, {
          where: { suggestId: s.id! },
        });
        if (!order) throw new BadRequestException('Đề xuất chưa có lệnh chi');
        returnAmount = partialSpendSummary(
          rows,
          Number(order.amount),
          rows.filter((row) => row.spent).map((row) => row.id),
        ).returnAmount;
        cashAccount = order.cashAccount ?? null;
        // Nhiều nguồn chi: phần dư trả về các nguồn sau cùng (trừ ngược).
        const splits = orderCashSplits(order);
        if (splits.length > 1) {
          returnSplits = returnCashSplits(splits, returnAmount ?? 0);
        }
      },
      // Sổ quỹ đọc returnAmount để ghi bút toán thu phần dư.
      logData: () => ({
        returnAmount,
        cashAccount,
        ...(returnSplits ? { returnSplits } : {}),
      }),
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '✅ Thủ quỹ đã nhận lại phần dư',
        message:
          `Thủ quỹ đã nhận lại phần dư ${formatMoneyVnd(returnAmount ?? 0)} đ` +
          ` của đề xuất ${saved.code}`,
        senderId: user.id,
        meta: { status: saved.status, returnAmount },
      },
      { userIds: saved.createdBy ? [saved.createdBy] : [] },
    );

    return saved;
  }

  /** Kế toán lập/sửa số tiền: phần chia theo trường lúc duyệt không còn đúng. */
  private async clearMonthlyItemSplit(manager: EntityManager, suggestId: number) {
    await manager.update(
      SuggestMonthlyItem,
      { suggestId },
      { approvedAmount: null, spent: null },
    );
  }

  // ================= BƯỚC 7 — THỦ QUỸ xác nhận đã nhận lại quỹ =================

  async confirmFundReturned(id: number, user: AuthUser, note?: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_FUND_RETURNED,
      user,
      note,
      mutate: (s) => {
        s.fundReturnedBy = user.id;
        s.fundReturnedAt = new Date();
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '↩️ Đã hoàn quỹ',
        message:
          `Đề xuất ${saved.code} đã hoàn quỹ,` +
          ` kế toán công nợ có thể lập lại lệnh chi`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT] },
    );

    return saved;
  }


  // ============================================================
  // ===== Nhánh ĐỀ XUẤT THIẾT BỊ — phòng kỹ thuật & kho =====
  // ============================================================

  /** BƯỚC 3' — PHÒNG KỸ THUẬT lên lệnh xuất kho */
  async createExpenseStockIssueOrder(
    id: number,
    dto: CreateStockIssueOrderDto,
    user: AuthUser,
  ) {
    let stockIssueOrder: SuggestStockIssueOrder | null = null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CREATE_STOCK_ISSUE_ORDER,
      user,
      note: dto.note,
      logData: () => ({
        stockIssueOrder: {
          code: (stockIssueOrder as SuggestStockIssueOrder | null)?.code ?? null,
          items: dto.items,
          warehouse: dto.warehouse ?? null,
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
        },
      }),
      mutate: (s) => {
        // Thiết bị có thể được xuất lại sau khi đã nhập kho trở lại — xoá dấu
        // vết của vòng trước, giống `createExpensePaymentOrder` ở nhánh tiền.
        s.equipmentReceivedAt = null;
        s.spentAt = null;
        s.notSpentReason = null;
        s.equipmentReturnedBy = null;
        s.equipmentReturnedAt = null;
      },
      extra: async (manager, s) => {
        const code = await this.generateCode(
          manager,
          'suggest_stock_issue_order',
          'code',
          'XK',
        );

        // Quan hệ 1-1: lệnh xuất kho mới thay lệnh của vòng đã nhập lại kho,
        // lịch sử chuyển trạng thái vẫn giữ nguyên.
        await manager.delete(SuggestStockIssueOrder, { suggestId: s.id! });

        stockIssueOrder = await manager.save(SuggestStockIssueOrder, {
          code,
          suggestId: s.id!,
          items: dto.items,
          warehouse: dto.warehouse ?? null,
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
          note: dto.note ?? null,
          createdBy: user.id,
        });

        // Thiết bị chọn từ kho có sẵn (`warehouseItemId`) sẽ tự trừ tồn ngay
        // khi lệnh xuất kho được lập.
        const warehouseLines = dto.items
          .filter((it) => it.warehouseItemId != null)
          .map((it) => ({
            warehouseItemId: it.warehouseItemId!,
            quantity: it.quantity,
          }));

        if (warehouseLines.length > 0) {
          await this.warehouseService.exportForSuggestWithManager(
            manager,
            warehouseLines,
            user.id,
            s.id!,
          );
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Lệnh xuất kho mới',
        message:
          `Lệnh xuất kho ${(stockIssueOrder as SuggestStockIssueOrder | null)?.code} đã được lập` +
          ` cho đề xuất ${saved.code}, vui lòng xác nhận khi nhận thiết bị`,
        senderId: user.id,
        meta: {
          status: saved.status,
          stockIssueOrderId: (stockIssueOrder as SuggestStockIssueOrder | null)
            ?.id,
        },
      },
      { userIds: saved.createdBy ? [saved.createdBy] : [] },
    );

    return { suggest: saved, stockIssueOrder };
  }

  /** BƯỚC 4' — SALES xác nhận đã nhận thiết bị */
  async confirmEquipmentReceived(id: number, user: AuthUser, note?: string) {
    return this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_EQUIPMENT_RECEIVED,
      user,
      note,
      mutate: (s) => {
        s.equipmentReceivedAt = new Date();
      },
    });
  }

  /** BƯỚC 5' — PHÒNG KỸ THUẬT xác nhận đã nhận lại thiết bị chưa dùng */
  async confirmEquipmentReturned(id: number, user: AuthUser, note?: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_EQUIPMENT_RETURNED,
      user,
      note,
      mutate: (s) => {
        s.equipmentReturnedBy = user.id;
        s.equipmentReturnedAt = new Date();
      },
      extra: async (manager, s) => {
        // Thiết bị đã xuất từ kho có sẵn (`warehouseItemId`) được nhập lại
        // kho khi kinh doanh trả lại, để phòng kỹ thuật lập lại lệnh xuất kho
        // từ đúng số tồn.
        const order = await manager.findOne(SuggestStockIssueOrder, {
          where: { suggestId: s.id! },
        });
        const lines = (order?.items ?? [])
          .filter((it) => it.warehouseItemId != null)
          .map((it) => ({
            warehouseItemId: it.warehouseItemId!,
            quantity: it.quantity,
          }));

        if (lines.length > 0) {
          await this.warehouseService.importForSuggestWithManager(
            manager,
            lines,
            user.id,
            s.id!,
          );
        }
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Thiết bị đã nhập lại kho',
        message:
          `Thiết bị của đề xuất ${saved.code} đã nhập lại kho,` +
          ` phòng kỹ thuật có thể lập lại lệnh xuất kho`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { roles: [ExpenseRole.TECHNICAL] },
    );

    return saved;
  }

  // ============================================================
  // ===== ĐỀ XUẤT THIẾT BỊ mua từ NHÀ CUNG CẤP =====
  // ============================================================

  /**
   * Người xử lý được Giám đốc chỉ định lập phiếu nhập kho thật: thiết bị chưa
   * có mã trong kho được tạo mới, tồn kho tăng qua phiếu PNK. Nếu có đơn giá,
   * tổng tiền phiếu thành số tiền đề xuất — số chạy về Quản lý thu chi.
   */
  async createStockInReceipt(
    id: number,
    dto: CreateStockInReceiptDto,
    user: AuthUser,
  ) {
    const items = this.normalizeStockInItems(dto.items);
    const total = this.stockInTotal(items);
    let order: SuggestStockInOrder | null = null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CREATE_STOCK_IN_RECEIPT,
      user,
      note: dto.note,
      logData: async (manager) => {
        const o = order as SuggestStockInOrder | null;
        const receipt = o?.warehouseReceiptId
          ? await manager.findOne(WarehouseReceipt, {
              where: { id: o.warehouseReceiptId },
            })
          : null;
        return {
          stockIn: {
            code: o?.code ?? null,
            warehouseReceiptCode: receipt?.code ?? null,
            items: o?.items ?? items,
            total,
          },
        };
      },
      mutate: (s) => {
        if (total > 0) s.amount = total;
      },
      extra: async (manager, s) => {
        order = await manager.findOne(SuggestStockInOrder, {
          where: { suggestId: s.id! },
        });
        if (!order) {
          throw new BadRequestException(
            'Đề xuất chưa có phiếu nhập kho dự kiến của Giám đốc',
          );
        }

        const { receipt, itemIds } =
          await this.warehouseService.importPurchaseForSuggestWithManager(
            manager,
            items,
            user.id,
            s.id!,
            `Nhập kho theo phiếu ${order.code} của đề xuất ${s.code}`,
          );

        order.items = items.map((it, i) => ({
          ...it,
          warehouseItemId: itemIds[i],
        }));
        order.note = dto.note?.trim() || null;
        order.warehouseReceiptId = receipt.id;
        order.stockedBy = user.id;
        order.stockedAt = new Date();
        order = await manager.save(order);
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Thiết bị đã nhập kho, chờ nghiệm thu',
        message:
          `Đề xuất ${saved.code} đã nhập kho,` +
          ` vui lòng nghiệm thu bàn giao và xác nhận hoàn thành`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { userIds: saved.acceptorId ? [saved.acceptorId] : [] },
    );
    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '📦 Thiết bị đã nhập kho',
        message: `Thiết bị của đề xuất ${saved.code} đã nhập kho, đang chờ nghiệm thu`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      {
        userIds: [saved.createdBy, saved.approvedBy].filter(
          (v): v is number => !!v && v !== saved.acceptorId,
        ),
      },
    );

    return { suggest: saved, stockInOrder: order };
  }

  /**
   * Người nghiệm thu xác nhận đã bàn giao — kết thúc ở `SPENT` để đề xuất
   * được tính vào Quản lý thu chi như mọi đề xuất đã chi khác.
   */
  async confirmStockInAccepted(
    id: number,
    user: AuthUser,
    note?: string,
    files?: UploadedAttachment[],
  ) {
    let policySpent: Record<string, unknown> = {};
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.CONFIRM_STOCK_IN_ACCEPTED,
      user,
      note,
      logData: (_manager, s) => ({
        amount: s.amount != null ? Number(s.amount) : null,
        ...policySpent,
      }),
      mutate: (s) => {
        s.spentAt = new Date();
      },
      extra: async (manager, s) => {
        await this.saveExpenseAttachments(
          manager,
          s.id!,
          files,
          user.id,
          ExpenseAction.CONFIRM_STOCK_IN_ACCEPTED,
        );
        policySpent = await this.recordPolicySupportSpent(manager, s.id!);
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '✅ Đề xuất thiết bị mới đã hoàn thành',
        message:
          `Đề xuất ${saved.code} đã nghiệm thu bàn giao xong,` +
          ` đã chuyển về Quản lý thu chi`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      {
        roles: [
          ExpenseRole.DIRECTOR,
          ExpenseRole.DEBT_ACCOUNTANT,
          ExpenseRole.CHIEF_ACCOUNTANT,
          ExpenseRole.ACCOUNTANT,
        ],
        userIds: [saved.createdBy, saved.stockInHandlerId].filter(
          (v): v is number => !!v,
        ),
      },
    );

    return saved;
  }

  // ================= NHÁNH SỬA CHỮA =================

  /** Phòng kỹ thuật chỉ cần xác nhận nhận việc; đây là trạng thái kết thúc. */
  async acceptRepair(id: number, user: AuthUser) {
    let policySpent: Record<string, unknown> = {};
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.ACCEPT_REPAIR,
      user,
      mutate: (s) => {
        s.technicalRespondedBy = user.id;
        s.technicalRespondedAt = new Date();
        s.technicalRejectReason = null;
      },
      // Sửa chữa kết thúc ở đây (Chính sách năm tính là đã chi).
      extra: async (manager, s) => {
        policySpent = await this.recordPolicySupportSpent(manager, s.id!);
      },
      logData: () => policySpent,
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '✅ Phòng kỹ thuật đã nhận việc',
        message: `Phòng kỹ thuật đã nhận xử lý đề xuất sửa chữa ${saved.code}`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      {
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /** Phòng kỹ thuật từ chối nhận việc sửa chữa và bắt buộc lưu lý do. */
  async rejectRepair(id: number, user: AuthUser, reason: string) {
    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.REJECT_REPAIR,
      user,
      note: reason,
      mutate: (s) => {
        s.technicalRespondedBy = user.id;
        s.technicalRespondedAt = new Date();
        s.technicalRejectReason = reason;
      },
      extra: async (manager, s) => {
        // Từ chối việc sửa chữa chính là người bàn giao từ chối việc được giao.
        await manager.update(
          SuggestAssignment,
          {
            suggestId: s.id!,
            employeeId: user.id,
            role: AssignmentRole.HANDOVER,
            status: AssignmentStatus.ASSIGNED,
          },
          {
            status: AssignmentStatus.DECLINED,
            declineReason: reason,
            declinedAt: new Date(),
          },
        );
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '❌ Phòng kỹ thuật từ chối nhận việc',
        message: `Phòng kỹ thuật từ chối đề xuất sửa chữa ${saved.code}: ${reason}`,
        senderId: user.id,
        meta: { status: saved.status, reason },
      },
      {
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        userIds: saved.createdBy ? [saved.createdBy] : [],
      },
    );

    return saved;
  }

  /**
   * Giám đốc/Sales Admin chỉ định nhân viên kỹ thuật khác sau khi người
   * trước từ chối nhận việc — quay lại `APPROVED` với người phụ trách mới,
   * xoá dấu vết phản hồi (chấp nhận/từ chối) của vòng trước.
   */
  async reassignRepair(
    id: number,
    user: AuthUser,
    assignedTechnicianId: number,
  ) {
    const technician = await this.employeeRepo.findOne({
      where: { id: assignedTechnicianId },
    });
    if (!technician) {
      throw new NotFoundException('Nhân viên kỹ thuật không tồn tại');
    }
    if (!technician.roles?.includes(ExpenseRole.TECHNICAL)) {
      throw new BadRequestException(
        'Nhân viên được chỉ định không thuộc phòng kỹ thuật',
      );
    }
    const isSupporter = await this.dataSource
      .getRepository(SuggestAssignment)
      .count({
        where: {
          suggestId: id,
          employeeId: assignedTechnicianId,
          role: AssignmentRole.SUPPORT,
          status: In([AssignmentStatus.ASSIGNED, AssignmentStatus.DECLINED]),
        },
      });
    if (isSupporter > 0) {
      throw new BadRequestException(
        'Người này đang là người hỗ trợ của đề xuất, chọn người khác',
      );
    }

    const before = await this.repo.findOne({ where: { id } });
    const previousTechnicianId = before?.assignedTechnicianId ?? null;
    const previousRejectReason = before?.technicalRejectReason ?? null;

    const saved = await this.expenseTransition({
      id,
      action: ExpenseAction.REASSIGN_REPAIR,
      user,
      logData: async (manager, s) => {
        const people = await this.employeeRefs(manager, [
          previousTechnicianId,
          assignedTechnicianId,
        ]);
        return {
          assignment: {
            role: AssignmentRole.HANDOVER,
            from: previousTechnicianId
              ? people.get(previousTechnicianId) ?? null
              : null,
            fromReason: previousRejectReason,
            to: people.get(assignedTechnicianId) ?? null,
          },
        };
      },
      mutate: (s) => {
        s.assignedTechnicianId = assignedTechnicianId;
        s.technicalRespondedBy = null;
        s.technicalRespondedAt = null;
        s.technicalRejectReason = null;
      },
      extra: async (manager, s) => {
        await this.replaceHandoverAssignment(
          manager,
          s.id!,
          assignedTechnicianId,
          user.id,
        );
      },
    });

    await this.notifyExpense(
      {
        suggestId: saved.id!,
        title: '🛠️ Bạn được chỉ định phụ trách đề xuất sửa chữa',
        message: `Bạn được chỉ định phụ trách đề xuất sửa chữa ${saved.code} (giao lại)`,
        senderId: user.id,
        meta: { status: saved.status },
      },
      { userIds: [assignedTechnicianId] },
    );

    return saved;
  }

  // ============================================================
  // ===== GIAO VIỆC: người bàn giao + người hỗ trợ =====
  // ============================================================

  /**
   * Trạng thái còn được từ chối / thay người: việc chưa bắt đầu (đã duyệt mà
   * chưa xuất kho) — đã xuất kho hay đã sửa xong thì không còn nghĩa.
   */
  private static readonly ASSIGNMENT_OPEN_STATUSES: SuggestStatus[] = [
    SuggestStatus.APPROVED,
    SuggestStatus.EQUIPMENT_RETURNED,
  ];

  /** Người được giao phải còn làm việc và chưa có mặt trong danh sách giao việc. */
  private async assertAssignableEmployees(
    employeeIds: number[],
    alreadyAssignedIds: number[],
  ) {
    const duplicated = employeeIds.find((id) => alreadyAssignedIds.includes(id));
    if (duplicated) {
      throw new BadRequestException(
        'Người hỗ trợ không được trùng với người bàn giao hoặc người đã được giao',
      );
    }
    const found = await this.employeeRepo.find({
      where: { id: In(employeeIds), isActive: true },
      select: { id: true },
    });
    if (found.length !== employeeIds.length) {
      throw new NotFoundException('Có người hỗ trợ không tồn tại hoặc đã nghỉ');
    }
  }

  /** Đánh dấu người bàn giao cũ đã được thay và tạo dòng giao việc cho người mới. */
  private async replaceHandoverAssignment(
    manager: EntityManager,
    suggestId: number,
    newEmployeeId: number,
    actorId: number,
  ) {
    const created = await manager.save(SuggestAssignment, {
      suggestId,
      employeeId: newEmployeeId,
      role: AssignmentRole.HANDOVER,
      assignedBy: actorId,
    });
    await manager.update(
      SuggestAssignment,
      {
        suggestId,
        role: AssignmentRole.HANDOVER,
        status: In([AssignmentStatus.ASSIGNED, AssignmentStatus.DECLINED]),
        id: Not(created.id),
      },
      { status: AssignmentStatus.REPLACED, replacedById: created.id },
    );
    return created;
  }

  /** Khoá đề xuất chi trong transaction để thao tác giao việc không chạy chồng nhau. */
  private async lockExpense(manager: EntityManager, id: number) {
    const s = await manager.findOne(Suggest, {
      where: { id, type: SuggestType.EXPENSE_REQUEST },
      lock: { mode: 'pessimistic_write' },
    });
    if (!s) throw new NotFoundException('Đề xuất chi không tồn tại');
    return s;
  }

  /**
   * Người bàn giao / người hỗ trợ từ chối việc được giao, lý do gửi về Giám
   * đốc. Không đổi trạng thái đề xuất — Giám đốc chọn người thay thế bằng
   * `replaceAssignment`. Người bàn giao của đề xuất sửa chữa dùng
   * `rejectRepair` (đã có trạng thái riêng REPAIR_REJECTED).
   */
  async declineAssignment(id: number, user: AuthUser, reason: string) {
    const actor = this.ensureUser(user);
    const trimmed = reason?.trim();
    if (!trimmed) throw new BadRequestException('Vui lòng nhập lý do từ chối');

    const { suggest, assignment } = await this.dataSource.transaction(
      async (manager) => {
        const s = await this.lockExpense(manager, id);
        const a = await manager.findOne(SuggestAssignment, {
          where: {
            suggestId: id,
            employeeId: actor.id,
            status: AssignmentStatus.ASSIGNED,
          },
        });
        if (!a) {
          throw new ForbiddenException(
            'Bạn không được giao việc trên đề xuất này hoặc đã từ chối rồi',
          );
        }
        if (
          a.role === AssignmentRole.HANDOVER &&
          s.requestKind === ExpenseRequestKind.REPAIR
        ) {
          throw new BadRequestException(
            'Người bàn giao đề xuất sửa chữa dùng nút "Từ chối" việc sửa chữa',
          );
        }
        if (
          !SuggestService.ASSIGNMENT_OPEN_STATUSES.includes(
            s.status as SuggestStatus,
          )
        ) {
          throw new BadRequestException(
            'Việc đã bắt đầu thực hiện nên không từ chối được nữa',
          );
        }

        a.status = AssignmentStatus.DECLINED;
        a.declineReason = trimmed;
        a.declinedAt = new Date();
        await manager.save(a);

        await this.writeExpenseLog(manager, {
          suggestId: id,
          userId: actor.id,
          action: ExpenseAction.DECLINE_ASSIGNMENT,
          fromStatus: s.status,
          toStatus: s.status,
          note: trimmed,
          details: {
            assignment: {
              role: a.role,
              from: (await this.employeeRefs(manager, [actor.id])).get(actor.id) ?? null,
              fromReason: trimmed,
            },
            // Có người từ chối thì việc tiếp theo là Giám đốc chọn người thay.
            next: { people: [], departments: ['Giám đốc', 'Sales Admin'] },
            acceptor: s.acceptorId
              ? (await this.employeeRefs(manager, [s.acceptorId])).get(s.acceptorId) ?? null
              : null,
          },
        });

        return { suggest: s, assignment: a };
      },
    );

    const roleLabel =
      assignment.role === AssignmentRole.SUPPORT
        ? 'hỗ trợ'
        : suggest.requestKind === ExpenseRequestKind.REPAIR
          ? 'đảm nhận'
          : 'bàn giao';
    await this.notifyExpense(
      {
        suggestId: id,
        title: `❌ Người ${roleLabel} từ chối nhận việc`,
        message:
          `${fixVietnamese(actor.name ?? 'Nhân viên')} từ chối ${roleLabel} đề xuất` +
          ` ${suggest.code}: ${trimmed}. Vui lòng chọn người thay thế`,
        senderId: actor.id,
        meta: { status: suggest.status, reason: trimmed, assignmentId: assignment.id },
      },
      {
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        userIds: suggest.approvedBy ? [suggest.approvedBy] : [],
      },
    );

    return this.findOneExpense(id, actor);
  }

  /**
   * Giám đốc/Sales Admin chọn người thay thế cho một người đã từ chối. Thay
   * người bàn giao thì người mới cũng thành người giữ bước kỹ thuật.
   */
  async replaceAssignment(
    id: number,
    assignmentId: number,
    user: AuthUser,
    employeeId: number,
  ) {
    const actor = this.ensureUser(user);

    const { suggest, created } = await this.dataSource.transaction(
      async (manager) => {
        const s = await this.lockExpense(manager, id);
        const old = await manager.findOne(SuggestAssignment, {
          where: { id: assignmentId, suggestId: id },
        });
        if (!old) throw new NotFoundException('Không tìm thấy người được giao');
        if (old.status !== AssignmentStatus.DECLINED) {
          throw new BadRequestException(
            'Chỉ chọn người thay thế cho người đã từ chối',
          );
        }
        if (
          old.role === AssignmentRole.HANDOVER &&
          s.requestKind === ExpenseRequestKind.REPAIR
        ) {
          throw new BadRequestException(
            'Đề xuất sửa chữa dùng "Chỉ định người khác" để thay người bàn giao',
          );
        }
        const openStatuses: SuggestStatus[] = [
          ...SuggestService.ASSIGNMENT_OPEN_STATUSES,
          // Người bàn giao từ chối sửa chữa thì người hỗ trợ vẫn cần thay được.
          SuggestStatus.REPAIR_REJECTED,
        ];
        if (!openStatuses.includes(s.status as SuggestStatus)) {
          throw new BadRequestException(
            'Việc đã bắt đầu thực hiện nên không thay người được nữa',
          );
        }

        const active = await manager.find(SuggestAssignment, {
          where: {
            suggestId: id,
            status: In([AssignmentStatus.ASSIGNED, AssignmentStatus.DECLINED]),
          },
        });
        await this.assertAssignableEmployees(
          [employeeId],
          active.map((a) => a.employeeId),
        );

        let createdRow: SuggestAssignment;
        if (old.role === AssignmentRole.HANDOVER) {
          const employee = await manager.findOne(Employee, {
            where: { id: employeeId },
          });
          if (!employee?.roles?.includes(ExpenseRole.TECHNICAL)) {
            throw new BadRequestException(
              'Người bàn giao phải thuộc phòng kỹ thuật',
            );
          }
          createdRow = await this.replaceHandoverAssignment(
            manager,
            id,
            employeeId,
            actor.id,
          );
          s.assignedTechnicianId = employeeId;
          await manager.save(s);
        } else {
          createdRow = await manager.save(SuggestAssignment, {
            suggestId: id,
            employeeId,
            role: AssignmentRole.SUPPORT,
            assignedBy: actor.id,
          });
          old.status = AssignmentStatus.REPLACED;
          old.replacedById = createdRow.id;
          await manager.save(old);
        }

        const people = await this.employeeRefs(manager, [
          old.employeeId,
          employeeId,
        ]);
        await this.writeExpenseLog(manager, {
          suggestId: id,
          userId: actor.id,
          action: ExpenseAction.REPLACE_ASSIGNMENT,
          fromStatus: s.status,
          toStatus: s.status,
          details: {
            assignment: {
              role: old.role,
              from: people.get(old.employeeId) ?? null,
              fromReason: old.declineReason ?? null,
              to: people.get(employeeId) ?? null,
            },
            ...(await this.expenseNextStepDetails(manager, s)),
          },
        });

        return { suggest: s, created: createdRow };
      },
    );

    await this.notifyExpense(
      {
        suggestId: id,
        title:
          created.role === AssignmentRole.HANDOVER
            ? '🛠️ Bạn được chỉ định bàn giao đề xuất'
            : '🤝 Bạn được chỉ định hỗ trợ',
        message:
          created.role === AssignmentRole.HANDOVER
            ? `Bạn được chỉ định thay người bàn giao đề xuất ${suggest.code}`
            : `Bạn được chỉ định thay người hỗ trợ đề xuất ${suggest.code}`,
        senderId: actor.id,
        meta: { status: suggest.status },
      },
      { userIds: [employeeId] },
    );

    return this.findOneExpense(id, actor);
  }

  // ================= QUERY =================

  /**
   * Điều kiện SQL (alias 's'): nhân viên `:param` được Giám đốc chỉ định trên
   * đề xuất — người bàn giao, người hỗ trợ, người xử lý nhập kho hoặc người
   * nghiệm thu. Gồm cả dòng giao việc đã từ chối/đã được thay để người đó còn
   * xem lại được đề xuất mình từng tham gia.
   */
  private expenseAssignedToSql(param: string): string {
    return `(
      s.assignedTechnicianId = :${param}
      OR s.stockInHandlerId = :${param}
      OR s.acceptorId = :${param}
      OR EXISTS (
        SELECT 1 FROM suggest_assignment sa
        WHERE sa."suggestId" = s.id AND sa."employeeId" = :${param}
      )
    )`;
  }

  /** Bản trong bộ nhớ của `expenseAssignedToSql` cho một đề xuất đã nạp `assignments`. */
  private isExpenseAssignedTo(s: Suggest, employeeId: number): boolean {
    return (
      s.assignedTechnicianId === employeeId ||
      s.stockInHandlerId === employeeId ||
      s.acceptorId === employeeId ||
      (s.assignments ?? []).some((a) => a.employeeId === employeeId)
    );
  }

  /** Áp các bộ lọc chung của đề xuất chi lên query builder (alias 's'). */
  private applyExpenseFilters(
    qb: SelectQueryBuilder<Suggest>,
    filter: FilterExpenseDto,
    actor?: AuthUser,
  ) {
    const {
      status,
      requestKind,
      createdBy,
      includeAssigned,
      schoolId,
      isMonthlyExpense,
      subjectId,
      expensePeriodId,
      schoolYear,
      fromDate,
      toDate,
      overdue,
    } = filter;

    if (status) qb.andWhere('s.status = :status', { status });
    if (requestKind)
      qb.andWhere('s.requestKind = :requestKind', { requestKind });
    if (createdBy) {
      // "Đề xuất của tôi" kèm cả đề xuất mình được Giám đốc chỉ định — chỉ khi
      // người xem lọc theo chính mình, không mở rộng khi xem đơn người khác.
      if (includeAssigned && actor?.id === createdBy) {
        qb.andWhere(
          `(s.createdBy = :createdBy OR ${this.expenseAssignedToSql('createdBy')})`,
          { createdBy },
        );
      } else {
        qb.andWhere('s.createdBy = :createdBy', { createdBy });
      }
    }
    // Đề xuất chi tháng nhiều trường: khớp cả các trường sau trường đầu.
    const matchesMonthlyItem = (column: string, param: string) =>
      `EXISTS (
        SELECT 1 FROM suggest_monthly_items smi
        WHERE smi.suggest_id = s.id AND smi.${column} = :${param}
      )`;
    if (schoolId !== undefined && schoolId !== null)
      qb.andWhere(
        `(s.schoolId = :schoolId OR ${matchesMonthlyItem('school_id', 'schoolId')})`,
        { schoolId },
      );
    if (isMonthlyExpense !== undefined)
      qb.andWhere('s.isMonthlyExpense = :isMonthlyExpense', {
        isMonthlyExpense,
      });
    if (subjectId !== undefined && subjectId !== null)
      qb.andWhere(
        `(s.subjectId = :subjectId OR ${matchesMonthlyItem('subject_id', 'subjectId')})`,
        { subjectId },
      );
    if (expensePeriodId !== undefined && expensePeriodId !== null)
      qb.andWhere(
        `(s.expensePeriodId = :expensePeriodId OR ${matchesMonthlyItem('expense_period_id', 'expensePeriodId')})`,
        { expensePeriodId },
      );
    if (schoolYear) qb.andWhere('s.schoolYear = :schoolYear', { schoolYear });
    if (fromDate)
      qb.andWhere('s.expectedPaymentDate >= :fromDate', { fromDate });
    if (toDate) qb.andWhere('s.expectedPaymentDate <= :toDate', { toDate });
    if (overdue !== undefined)
      qb.andWhere('s.isOverdue = :overdue', { overdue });

    return qb;
  }

  /** Tài khoản chỉ thuộc phòng kỹ thuật, không kiêm vai trò ở nhánh khác. */
  private isTechnicalOnly(actor?: AuthUser): boolean {
    const roles = actor?.roles ?? [];
    if (!roles.includes(ExpenseRole.TECHNICAL)) return false;
    const otherExpenseRoles: string[] = [
      ExpenseRole.SALES,
      ExpenseRole.STAFF_TEACHER,
      ExpenseRole.DIRECTOR,
      ExpenseRole.DEBT_ACCOUNTANT,
      ExpenseRole.TREASURER,
      ExpenseRole.SALES_ADMIN,
      ExpenseRole.CHIEF_ACCOUNTANT,
      ExpenseRole.ACCOUNTANT,
    ];
    return !roles.some((r) => otherExpenseRoles.includes(r));
  }

  /** Chủ đơn thuần chỉ được xem đề nghị do chính mình tạo. */
  private isRequesterOnly(actor?: AuthUser): boolean {
    const roles = actor?.roles ?? [];
    if (!roles.some((role) => EXPENSE_REQUESTER_ROLES.includes(role))) {
      return false;
    }
    const broadRoles: string[] = [
      ExpenseRole.DIRECTOR,
      ExpenseRole.DEBT_ACCOUNTANT,
      ExpenseRole.TREASURER,
      ExpenseRole.SALES_ADMIN,
      ExpenseRole.CHIEF_ACCOUNTANT,
      ExpenseRole.ACCOUNTANT,
      ExpenseRole.TECHNICAL,
    ];
    return !roles.some((role) => broadRoles.includes(role));
  }

  /**
   * Chủ đơn thuần chỉ xem đề xuất của mình. Phòng kỹ thuật chỉ xem đề xuất
   * thiết bị/sửa chữa; nếu Giám đốc đã chỉ định người phụ trách thì chỉ kỹ
   * thuật viên đó nhìn thấy đề xuất. Ai được Giám đốc chỉ định trên đề xuất
   * (bàn giao, hỗ trợ, xử lý nhập kho, nghiệm thu) luôn xem được đề xuất đó.
   */
  private applyExpenseAccessScope(
    qb: SelectQueryBuilder<Suggest>,
    actor?: AuthUser,
  ) {
    if (this.isRequesterOnly(actor)) {
      return qb.andWhere(
        `(s.createdBy = :requesterId OR ${this.expenseAssignedToSql('requesterId')})`,
        { requesterId: actor!.id },
      );
    }
    if (!this.isTechnicalOnly(actor)) return qb;

    return qb.andWhere(
      `(
        (
          s.requestKind IN (:...technicalKinds)
          AND s.assignedTechnicianId IS NULL
        )
        OR ${this.expenseAssignedToSql('technicalActorId')}
      )`,
      {
        technicalKinds: [
          ExpenseRequestKind.EQUIPMENT,
          ExpenseRequestKind.REPAIR,
        ],
        technicalActorId: actor!.id,
      },
    );
  }

  async findAllExpense(rawFilter: FilterExpenseDto, actor?: AuthUser) {
    const filter = rawFilter;
    const { page = 1, limit = 20 } = filter;

    const qb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.createdByUser', 'creator')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.stockInOrder', 'sino')
      .leftJoinAndSelect('s.school', 'school')
      .leftJoinAndSelect('s.subject', 'subject')
      .leftJoinAndSelect('s.expensePeriod', 'expensePeriod')
      .leftJoinAndSelect('s.monthlyItems', 'monthlyItem')
      .leftJoinAndSelect('monthlyItem.school', 'monthlyItemSchool')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST });

    this.applyExpenseFilters(qb, filter, actor);
    this.applyExpenseAccessScope(qb, actor);

    const [data, total] = await qb
      .orderBy('s.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Danh sách đề xuất chi GOM NHÓM THEO NHÂN VIÊN (người tạo).
   * Phân trang theo nhân viên: mỗi trang là `limit` nhân viên, kèm toàn bộ
   * đề xuất của họ + tổng số & tổng tiền. Dùng chung bộ lọc của findAllExpense.
   */
  async findAllExpenseGroupedByEmployee(
    rawFilter: FilterExpenseDto,
    actor?: AuthUser,
  ) {
    const filter = rawFilter;
    const { page = 1, limit = 20 } = filter;

    // Bước 1: tổng hợp theo nhân viên, sắp xếp theo đề xuất gần nhất
    const groupQb = this.repo
      .createQueryBuilder('s')
      .select('s.createdBy', 'employeeId')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(s.amount), 0)', 'totalAmount')
      .addSelect('MAX(s.createdAt)', 'lastCreatedAt')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST })
      .andWhere('s.createdBy IS NOT NULL');

    this.applyExpenseFilters(groupQb, filter, actor);
    this.applyExpenseAccessScope(groupQb, actor);

    const groupsRaw = await groupQb
      .groupBy('s.createdBy')
      .orderBy('MAX(s.createdAt)', 'DESC')
      .getRawMany();

    const total = groupsRaw.length; // tổng số nhân viên
    const pageGroups = groupsRaw.slice((page - 1) * limit, page * limit);
    const employeeIds = pageGroups
      .map((g) => Number(g.employeeId))
      .filter((id): id is number => !!id);

    if (employeeIds.length === 0) {
      return {
        data: [],
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      };
    }

    // Bước 2: lấy đề xuất của các nhân viên trong trang (cùng bộ lọc)
    const itemsQb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.stockInOrder', 'sino')
      .leftJoinAndSelect('s.school', 'school')
      .leftJoinAndSelect('s.subject', 'subject')
      .leftJoinAndSelect('s.expensePeriod', 'expensePeriod')
      .leftJoinAndSelect('s.monthlyItems', 'monthlyItem')
      .leftJoinAndSelect('monthlyItem.school', 'monthlyItemSchool')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST })
      .andWhere('s.createdBy IN (:...employeeIds)', { employeeIds });

    this.applyExpenseFilters(itemsQb, filter, actor);
    this.applyExpenseAccessScope(itemsQb, actor);

    const items = await itemsQb.orderBy('s.createdAt', 'DESC').getMany();

    // Thông tin nhân viên (chỉ id/name/phone — không lộ password)
    const employees = await this.dataSource.getRepository(Employee).find({
      where: { id: In(employeeIds) },
      select: { id: true, name: true, phone: true },
    });
    const employeeById = new Map(employees.map((e) => [e.id, e]));

    const requestsByEmployee = new Map<number, Suggest[]>();
    for (const s of items) {
      const key = s.createdBy!;
      if (!requestsByEmployee.has(key)) requestsByEmployee.set(key, []);
      requestsByEmployee.get(key)!.push(s);
    }

    // Bước 3: dựng nhóm theo đúng thứ tự đã phân trang
    const data = pageGroups.map((g) => {
      const employeeId = Number(g.employeeId);
      const emp = employeeById.get(employeeId);
      return {
        employeeId,
        employee: emp
          ? { id: emp.id, name: emp.name, phone: emp.phone ?? null }
          : null,
        total: Number(g.count),
        totalAmount: Number(g.totalAmount),
        requests: requestsByEmployee.get(employeeId) ?? [],
      };
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Bảng Chi Ngoài của đề xuất: đề xuất tháng lấy đúng kỳ + môn của từng trường
   * trong đề xuất (theo thứ tự đã chọn), đề xuất năm lấy mọi kỳ của năm học.
   */
  private async loadManagementExpenseSections(
    s: Suggest,
  ): Promise<ManagementViewSection[]> {
    if (!s.isMonthlyExpense) {
      if (!s.schoolId) return [];
      return this.loadSchoolManagementSections(s.schoolId, null, {
        schoolYear: s.schoolYear,
        subjectId: null,
      });
    }

    let items = await this.storedMonthlyItemsInput(this.dataSource.manager, s);
    if (isSalesPick(s)) {
      // Chỉ khoản Chi Ban quản lí (bảng Chi Ngoài).
      const rows = await this.dataSource.manager.find(SuggestMonthlyItem, {
        where: { suggestId: s.id! },
        order: { position: 'ASC', id: 'ASC' },
      });
      items = rows
        .filter((row) => itemSourceOf(row, s) === 'MANAGEMENT')
        .map((row) => ({
          schoolId: row.schoolId,
          schoolYear: row.schoolYear,
          subjectId: row.subjectId,
          expensePeriodId: row.expensePeriodId,
        }));
      if (!items.length) return [];
    }
    // Quy trình Kế toán chưa gửi số liệu: cả bảng Chi Ngoài của trường trong kỳ.
    if (
      isAccountantChain(s) &&
      s.schoolId &&
      s.expensePeriodId &&
      items.every((item) => !item.subjectId)
    ) {
      return this.loadSchoolManagementSections(s.schoolId, s.expensePeriodId, {
        schoolYear: null,
        subjectId: null,
      });
    }
    const sections: ManagementViewSection[] = [];
    for (const item of items) {
      if (!item.schoolId || !item.expensePeriodId || !item.subjectId) continue;
      sections.push(
        ...(await this.loadSchoolManagementSections(
          item.schoolId,
          item.expensePeriodId,
          { schoolYear: item.schoolYear ?? null, subjectId: item.subjectId },
        )),
      );
    }
    return sections;
  }

  private async loadSchoolManagementSections(
    schoolId: number,
    periodId: number | null,
    filter: { schoolYear?: string | null; subjectId?: number | null },
    manager: EntityManager = this.dataSource.manager,
  ): Promise<ManagementViewSection[]> {
    const sheets = await manager.getRepository(SchoolExpense).find({
      where: {
        school: { id: schoolId },
        ...(periodId ? { period: { id: periodId } } : {}),
      },
      relations: {
        school: true,
        period: true,
        managementExpenseItems: {
          subject: { catalog: true, policies: true },
          otherCosts: true,
        },
        revenueItems: { subject: true },
      },
    });
    const payments = await loadSuggestPayments(
      manager,
      sheets.flatMap((sheet) =>
        (sheet.managementExpenseItems ?? []).map((item) => item.id),
      ),
    );
    const viewPayments: ManagementViewSuggestPayments = new Map(
      [...payments].map(([itemId, info]) => [
        itemId,
        {
          paidDate: info.latest.paidDate,
          cashAccount: info.latest.cashAccount,
          codes: suggestCodesLabel(info),
        },
      ]),
    );
    const confirmations = await loadManagementConfirmations(
      manager,
      sheets.map((sheet) => sheet.id),
    );
    return buildManagementViewSections(
      sheets,
      filter,
      viewPayments,
      new Set(confirmations.map((c) => `${c.schoolExpenseId}:${c.subjectId}`)),
    );
  }

  private loadMonthlyRows(manager: EntityManager, suggestId: number) {
    return manager.find(SuggestMonthlyItem, {
      where: { suggestId },
      relations: {
        school: true,
        subject: { catalog: true },
        schoolTeacher: true,
        expensePeriod: true,
      },
      order: { position: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Kinh doanh xác nhận đã chi: ghi về đúng bảng nguồn của đề xuất trong cùng
   * transaction (lỗi thì đề xuất không thành Đã chi). Trả phần ghi vào lịch sử:
   * Chi Ngoài giữ khoá `chiNgoai` như trước, Chi Trường / Giáo viên trường là
   * `cashflowPayment`.
   */
  private async recordCashflowPayments(
    manager: EntityManager,
    s: Suggest,
    rows: SuggestMonthlyItem[],
  ): Promise<Record<string, unknown>> {
    // Nguồn chi Thủ quỹ đã xuất (có thể nhiều nguồn): các khoản lấy lần lượt
    // từ nguồn 1, hết thì sang nguồn 2… (19/11/2026).
    const order = await manager.findOne(SuggestPaymentOrder, {
      where: { suggestId: s.id! },
    });
    const splits = orderCashSplits(order);
    const cursor = createCashSplitCursor(splits);
    const cash: CashInput =
      splits.length > 1 ? (amount) => cursor.take(amount) : order?.cashAccount ?? null;
    // "Đề xuất chi tháng" tích chọn: mỗi khoản ghi về đúng bảng của nó.
    if (isSalesPick(s)) {
      const result: Record<string, unknown> = {};
      const logs: unknown[] = [];
      for (const source of CASHFLOW_SOURCES) {
        const own = rows.filter((row) => itemSourceOf(row, s) === source);
        if (!own.length) continue;
        const part = await this.recordSourcePayments(manager, s, source, own, cash);
        if (part.chiNgoai) result.chiNgoai = part.chiNgoai;
        if (part.cashflowPayment) logs.push(part.cashflowPayment);
      }
      if (logs.length === 1) result.cashflowPayment = logs[0];
      if (logs.length > 1) result.cashflowPayments = logs;
      return result;
    }
    return this.recordSourcePayments(
      manager,
      s,
      cashflowSourceOf(s) ?? 'MANAGEMENT',
      rows,
      cash,
    );
  }

  private async recordSourcePayments(
    manager: EntityManager,
    s: Suggest,
    source: CashflowSource,
    rows: SuggestMonthlyItem[],
    cash: CashInput,
  ): Promise<Record<string, unknown>> {
    if (source === 'MANAGEMENT') {
      const chiNgoai = await this.recordChiNgoaiPayments(manager, s, rows, cash);
      return chiNgoai ? { chiNgoai } : {};
    }
    const paidRows: CashflowPaidRow[] = rows.map((row) => ({
      monthlyItemId: row.id,
      schoolId: row.schoolId,
      expensePeriodId: row.expensePeriodId,
      subjectId: row.subjectId,
      schoolTeacherId: row.schoolTeacherId,
      approvedAmount: row.approvedAmount,
      label: monthlyItemLabel(row),
    }));
    const record =
      source === 'SCHOOL_EXPENSE'
        ? recordSchoolExpenseSuggestPayments
        : recordSchoolTeacherSuggestPayments;
    const log = await record(
      manager,
      s.id!,
      paidRows,
      vnToday(),
      cash,
    );
    for (const item of log && 'items' in log && log.items ? log.items : []) {
      if (item.unallocated > 0) {
        this.logger.warn(
          `Đề xuất ${s.code ?? s.id}: ${item.label} còn ${item.unallocated} đ không ghi được vào dòng ${log!.table} nào`,
        );
      }
    }
    return log ? { cashflowPayment: log } : {};
  }

  /**
   * Kinh doanh xác nhận đã chi (cả đề xuất, hoặc các trường đã tích khi chi một
   * phần): ghi Ngày chi / Nguồn chi / Đã chi vào bảng Chi Ngoài của từng trường.
   * Chỉ đề xuất chi tháng có lệnh chi hệ thống lập lúc Giám đốc duyệt (biết phần
   * của từng trường). Phần của trường chia cho các dòng theo Còn chi hiện tại.
   * Không chặn việc xác nhận: không ghi được thì ghi lý do vào lịch sử.
   */
  private async recordChiNgoaiPayments(
    manager: EntityManager,
    s: Suggest,
    rows: SuggestMonthlyItem[],
    cash: CashInput,
  ): Promise<ChiNgoaiPaymentLog | null> {
    if (!rows.length) return null;
    if (rows.some((row) => row.approvedAmount === null || row.approvedAmount === undefined)) {
      return {
        skipped:
          'Lệnh chi do Kế toán lập/sửa nên không chia được theo trường — Chi Ngoài không tự ghi, nhập tay ở QL thu chi',
      };
    }
    const take = cashTakerOf(cash);
    const used: { cashAccount: string | null; amount: number }[] = [];
    const partsByItem = new Map<number, { cashAccount: string | null; amount: number }[]>();
    const paidDate = vnToday();

    // Khoá các bảng Chi Ngoài liên quan theo thứ tự id, cùng khoá mà "Lưu" bảng
    // dùng — tránh ghi lẫn khi có người đang lưu bảng.
    const sheetIds = (
      await manager.query<{ id: number }[]>(
        `SELECT id FROM school_expenses
         WHERE (school_id, period_id) IN (
           SELECT * FROM unnest($1::int[], $2::int[])
         )
         ORDER BY id FOR UPDATE`,
        [
          rows.map((row) => row.schoolId ?? 0),
          rows.map((row) => row.expensePeriodId ?? 0),
        ],
      )
    ).map((row) => Number(row.id));

    const items: ChiNgoaiPaymentLog['items'] = [];
    for (const row of rows) {
      const amount = Number(row.approvedAmount) || 0;
      if (amount <= 0 || !row.schoolId || !row.expensePeriodId || !row.subjectId) {
        continue;
      }
      const sections = (
        await this.loadSchoolManagementSections(
          row.schoolId,
          row.expensePeriodId,
          { schoolYear: row.schoolYear ?? null, subjectId: row.subjectId },
          manager,
        )
      ).filter(
        (section) =>
          sheetIds.includes(section.schoolExpenseId) &&
          section.schoolId === row.schoolId &&
          section.subjectId === row.subjectId &&
          section.periodId === row.expensePeriodId,
      );
      const viewRows = sections.flatMap((section) =>
        section.rows
          .filter((viewRow) => viewRow.itemId)
          .map((viewRow) => ({
            itemId: viewRow.itemId!,
            remaining: viewRow.remaining,
            schoolExpenseId: section.schoolExpenseId,
            rowIndex: viewRow.rowIndex,
          })),
      );
      const { allocations, unallocated } = allocateSuggestPayment(viewRows, amount);
      for (const allocation of allocations) {
        await manager.query(
          `UPDATE management_expense_items
           SET "paidAmount" = "paidAmount" + $2,
               "remaining" = "totalOutside" - "paidAmount" - $2
           WHERE id = $1`,
          [allocation.itemId, allocation.amount],
        );
        // Nhiều nguồn chi: mỗi nguồn của dòng một bản ghi riêng.
        const parts = take(allocation.amount);
        partsByItem.set(allocation.itemId, parts);
        used.push(...parts);
        for (const part of parts) {
          await manager.query(
            `INSERT INTO management_expense_suggest_payments
               (management_expense_item_id, suggest_id, suggest_monthly_item_id,
                amount, paid_date, cash_account)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [allocation.itemId, s.id, row.id, part.amount, paidDate, part.cashAccount],
          );
        }
      }
      items.push({
        monthlyItemId: row.id,
        label: monthlyItemLabel(row),
        amount,
        unallocated,
        rows: allocations.map((allocation) => {
          const viewRow = viewRows.find((r) => r.itemId === allocation.itemId)!;
          return {
            itemId: allocation.itemId,
            schoolExpenseId: viewRow.schoolExpenseId,
            rowIndex: viewRow.rowIndex,
            amount: allocation.amount,
            ...multiAccounts(partsByItem.get(allocation.itemId)),
          };
        }),
      });
      if (unallocated > 0) {
        this.logger.warn(
          `Đề xuất ${s.code ?? s.id}: ${monthlyItemLabel(row)} không còn dòng Chi Ngoài để ghi ${unallocated} đ`,
        );
      }
    }
    const accounts = sumByAccount(used);
    return {
      paidDate,
      cashAccount:
        typeof cash === 'function' ? (accounts[0]?.cashAccount ?? null) : cash,
      ...(accounts.length > 1 ? { cashAccounts: accounts } : {}),
      items,
    };
  }

  /** Dòng trường của đề xuất chi tháng; đề xuất cũ chưa có dòng thì lấy từ các cột đơn. */
  private async storedMonthlyItemsInput(
    manager: EntityManager,
    s: Suggest,
  ): Promise<MonthlyItemInput[]> {
    const rows = s.monthlyItems ??
      (s.id
        ? await manager.find(SuggestMonthlyItem, {
            where: { suggestId: s.id },
            order: { position: 'ASC', id: 'ASC' },
          })
        : []);
    if (rows.length === 0) return monthlyItemsFromColumns(s);
    return [...rows]
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((row) => ({
        schoolId: row.schoolId,
        schoolYear: row.schoolYear,
        subjectId: row.subjectId,
        expensePeriodId: row.expensePeriodId,
      }));
  }

  /** "Đề xuất Chi Trường" / "Đề xuất Chi GV trường" / "Chi chính sách tháng". */
  private monthlyKindLabel(s: {
    isMonthlyExpense?: boolean | null;
    cashflowSource?: string | null;
    approvalFlow?: string | null;
  }) {
    if (isSalesPick(s)) return 'Đề xuất chi tháng';
    return CASHFLOW_SOURCE_LABELS[cashflowSourceOf(s) ?? 'MANAGEMENT'];
  }

  /** Đề xuất có khoản thuộc bảng Chi Ngoài (để chụp bảng lúc duyệt). */
  private async hasManagementItems(s: Suggest): Promise<boolean> {
    if (!isSalesPick(s)) return cashflowSourceOf(s) === 'MANAGEMENT';
    const rows = await this.dataSource.manager.find(SuggestMonthlyItem, {
      where: { suggestId: s.id! },
      select: { id: true, cashflowSource: true },
    });
    return rows.some((row) => itemSourceOf(row, s) === 'MANAGEMENT');
  }

  /** Khoá khoản của dòng đã lưu. */
  private cashflowRefOfRow(row: SuggestMonthlyItem): CashflowItemRef {
    return {
      schoolId: row.schoolId ?? null,
      expensePeriodId: row.expensePeriodId ?? null,
      subjectId: row.subjectId ?? null,
      schoolTeacherId: row.schoolTeacherId ?? null,
    };
  }

  /**
   * Khoản của QL thu chi (Phải chi / Đã chi / Còn lại) theo khoá
   * `cashflowItemKey`. Chi Ngoài dựng lại bảng như màn QL thu chi.
   */
  private async cashflowGroupsFor(
    manager: EntityManager,
    source: CashflowSource,
    refs: CashflowItemRef[],
  ): Promise<Map<string, CashflowGroup>> {
    const schoolIds = [
      ...new Set(refs.map((ref) => ref.schoolId).filter((id): id is number => !!id)),
    ];
    const periodIds = [
      ...new Set(refs.map((ref) => ref.expensePeriodId).filter((id): id is number => !!id)),
    ];
    let groups: CashflowGroup[] = [];
    if (!schoolIds.length || !periodIds.length) return new Map();
    if (source === 'SCHOOL_EXPENSE') {
      groups = await loadSchoolExpenseGroups(manager, { schoolIds, periodIds });
    } else if (source === 'SCHOOL_TEACHER') {
      groups = (await loadSchoolTeacherGroups(manager, { schoolIds, periodIds })).groups;
    } else {
      const periods = await this.loadPeriodInfo(manager, periodIds);
      const pairs = new Set(refs.map((ref) => `${ref.schoolId}:${ref.expensePeriodId}`));
      for (const pair of pairs) {
        const [schoolId, periodId] = pair.split(':').map(Number);
        if (!schoolId || !periodId) continue;
        const sections = await this.loadSchoolManagementSections(
          schoolId,
          periodId,
          { schoolYear: null, subjectId: null },
          manager,
        );
        groups.push(...managementGroupsFromSections(sections, periods));
      }
    }
    return new Map(groups.map((group) => [group.key, group]));
  }

  private async loadPeriodInfo(manager: EntityManager, periodIds: number[]) {
    const rows = periodIds.length
      ? await manager.query<
          { id: number; month: number | null; year: number | null; name: string | null }[]
        >(`SELECT id, month, year, name FROM expense_periods WHERE id = ANY($1)`, [periodIds])
      : [];
    return new Map(
      rows.map((row) => [
        Number(row.id),
        {
          month: row.month === null ? null : Number(row.month),
          year: row.year === null ? null : Number(row.year),
          name: row.name,
        },
      ]),
    );
  }

  /** Còn phải chi hiện tại của từng dòng đề xuất (bảng Chi Trường / Giáo viên trường). */
  private async cashflowItemAmounts(
    manager: EntityManager,
    source: CashflowSource,
    rows: SuggestMonthlyItem[],
  ): Promise<number[]> {
    const refs = rows.map((row) => this.cashflowRefOfRow(row));
    const groups = await this.cashflowGroupsFor(manager, source, refs);
    return refs.map((ref) =>
      Math.max(0, groups.get(cashflowItemKey(source, ref))?.remainingAmount ?? 0),
    );
  }

  /**
   * Ảnh chụp bảng Chi Ngoài lúc Giám đốc quyết định, lưu vào lịch sử vì bảng
   * còn đổi hằng tháng. Không chụp được thì vẫn cho duyệt: thiếu ảnh chụp không
   * nên chặn việc chi tiền.
   */
  private async managementExpenseSnapshot(
    s: Suggest,
  ): Promise<Record<string, unknown>> {
    try {
      return {
        managementExpense: {
          capturedAt: new Date().toISOString(),
          sections: await this.loadManagementExpenseSections(s),
        },
      };
    } catch (error) {
      this.logger.error(
        `Không chụp được bảng Chi Ngoài của đề xuất ${s.id}`,
        error as Error,
      );
      return {};
    }
  }

  async getExpenseManagementView(id: number) {
    const s = await this.repo.findOne({
      where: { id, type: SuggestType.EXPENSE_REQUEST },
    });
    if (!s) throw new NotFoundException('Đề xuất chi không tồn tại');
    // Chi Trường / Giáo viên trường không có bảng Chi Ngoài: xem /cashflow-items.
    const source = cashflowSourceOf(s);
    if (source && source !== 'MANAGEMENT' && !isSalesPick(s)) {
      return { sections: [], remainingTotal: 0, items: [] };
    }
    if (isSalesPick(s) && !(await this.hasManagementItems(s))) {
      return { sections: [], remainingTotal: 0, items: [] };
    }
    const sections = await this.loadManagementExpenseSections(s);
    const rows = s.isMonthlyExpense
      ? (
          await this.dataSource.getRepository(SuggestMonthlyItem).find({
            where: { suggestId: s.id! },
            order: { position: 'ASC', id: 'ASC' },
          })
        ).filter((row) => !isSalesPick(s) || itemSourceOf(row, s) === 'MANAGEMENT')
      : [];
    const amounts = monthlyItemAmounts(rows, sections);
    return {
      sections,
      // Chi tháng: số tiền lệnh chi sẽ lập khi Giám đốc duyệt (duyệt tất cả).
      remainingTotal: monthlyRemainingTotal(sections),
      // Còn chi của từng dòng trường — để Giám đốc bỏ bớt trường và thấy số mới.
      items: rows.map((row, index) => ({ id: row.id, amount: amounts[index] })),
    };
  }

  /**
   * Màn tạo đề xuất: khoản của bảng nguồn ở các trường mình phụ trách, kèm
   * Phải chi / Đã chi / Còn lại và trạng thái (Chưa chi, Đang đề xuất, Đã
   * duyệt chờ chi, Đã chi một phần, Đã chi đủ). Sửa đề xuất của chính mình thì
   * gửi `excludeSuggestId` để khoản của đề xuất đó không hiện là đang bị giữ.
   */
  async listCashflowItems(
    user: AuthUser,
    query: {
      source: CashflowSource;
      schoolId?: number;
      year?: number;
      month?: number;
      excludeSuggestId?: number;
    },
  ) {
    const actor = this.ensureUser(user);
    const source = query.source;
    if (!isCashflowSource(source)) {
      throw new BadRequestException('Loại đề xuất chi tháng không hợp lệ');
    }
    const manager = this.dataSource.manager;
    let schoolIds = await actorSchoolIds(manager, actor.id);
    if (query.schoolId) {
      if (!schoolIds.includes(query.schoolId)) {
        throw new ForbiddenException('Trường không thuộc trường bạn phụ trách');
      }
      schoolIds = [query.schoolId];
    }
    let excludeSuggestId: number | null = null;
    if (query.excludeSuggestId) {
      const own = await this.repo.findOne({
        where: { id: query.excludeSuggestId, createdBy: actor.id },
        select: { id: true },
      });
      excludeSuggestId = own?.id ?? null;
    }

    const filter = { schoolIds, year: query.year, month: query.month };
    let groups: CashflowGroup[] = [];
    let unassigned: Awaited<ReturnType<typeof loadSchoolTeacherGroups>>['unassigned'] = [];
    if (source === 'SCHOOL_EXPENSE') {
      groups = await loadSchoolExpenseGroups(manager, filter);
    } else if (source === 'SCHOOL_TEACHER') {
      ({ groups, unassigned } = await loadSchoolTeacherGroups(manager, filter));
    } else if (schoolIds.length) {
      // Chi Ngoài dựng lại bảng như màn QL thu chi, theo từng trường có kỳ khớp lọc.
      const params: unknown[] = [schoolIds];
      let where = 'school_id = ANY($1)';
      if (query.year) {
        params.push(query.year);
        where += ` AND year = $${params.length}`;
      }
      if (query.month) {
        params.push(query.month);
        where += ` AND month = $${params.length}`;
      }
      const periodRows = await manager.query<
        { id: number; school_id: number; month: number | null; year: number | null; name: string | null }[]
      >(`SELECT id, school_id, month, year, name FROM expense_periods WHERE ${where}`, params);
      const periods = new Map(
        periodRows.map((row) => [
          Number(row.id),
          {
            month: row.month === null ? null : Number(row.month),
            year: row.year === null ? null : Number(row.year),
            name: row.name,
          },
        ]),
      );
      for (const schoolId of new Set(periodRows.map((row) => Number(row.school_id)))) {
        const sections = await this.loadSchoolManagementSections(
          schoolId,
          null,
          { schoolYear: null, subjectId: null },
          manager,
        );
        groups.push(
          ...managementGroupsFromSections(
            sections.filter((section) => section.periodId && periods.has(section.periodId)),
            periods,
          ),
        );
      }
    }

    const open = await loadOpenCashflowRequests(manager, source, schoolIds, excludeSuggestId);
    const openByKey = new Map(open.map((request) => [request.key, request]));
    // Kỳ kế toán kế toán đã tạo ở các trường này — bộ lọc "Kỳ kế toán" của màn tạo đề xuất.
    const periods = schoolIds.length
      ? (
          await manager.query<
            { id: number; school_id: number; month: number; year: number; name: string | null }[]
          >(
            `SELECT id, school_id, month, year, name FROM expense_periods
             WHERE school_id = ANY($1) ORDER BY year DESC, month DESC, id`,
            [schoolIds],
          )
        ).map((row) => ({
          id: Number(row.id),
          schoolId: Number(row.school_id),
          month: Number(row.month),
          year: Number(row.year),
          name: row.name,
        }))
      : [];
    const items = groups
      .map((group) => {
        const holder = openByKey.get(group.key) ?? null;
        return {
          ...group,
          label: cashflowGroupLabel(group),
          status: cashflowItemStatus(group, holder),
          openRequest: holder
            ? { id: holder.suggestId, code: holder.code, status: holder.status }
            : null,
        };
      })
      .sort(
        (a, b) =>
          (b.periodYear ?? 0) - (a.periodYear ?? 0) ||
          (b.periodMonth ?? 0) - (a.periodMonth ?? 0) ||
          (a.schoolName ?? '').localeCompare(b.schoolName ?? '', 'vi') ||
          (a.subjectName ?? a.teacherName ?? '').localeCompare(
            b.subjectName ?? b.teacherName ?? '',
            'vi',
          ),
      );
    return { source, table: CASHFLOW_TABLE_LABELS[source], items, unassigned, periods };
  }

  /** Lương từng giáo viên trường: chủ đề xuất và nhóm được xem lương ở QL thu chi. */
  private canSeeTeacherPay(actor: AuthUser | undefined, s: { createdBy?: number | null }) {
    if (!actor) return false;
    if (s.createdBy === actor.id) return true;
    return (actor.roles ?? []).some((role) =>
      (CASHFLOW_TEACHER_PAY_ROLES as readonly string[]).includes(role),
    );
  }

  /**
   * Khoản của một đề xuất chi tháng với số hiện tại ở QL thu chi (Phải chi /
   * Đã chi / Còn lại) và phần đề xuất này đã ghi vào. `amount` là số sẽ vào
   * lệnh chi nếu Giám đốc duyệt bây giờ.
   */
  async getExpenseCashflowItems(id: number, user: AuthUser) {
    const actor = this.ensureUser(user);
    // Cùng quyền xem chi tiết đề xuất.
    const s = await this.findOneExpense(id, actor);
    const source = cashflowSourceOf(s);
    if (!source) return { source: null, table: null, items: [], remainingTotal: 0 };
    if (isSalesPick(s)) return this.salesPickCashflowItems(s as Suggest, actor);
    if (source === 'SCHOOL_TEACHER' && !this.canSeeTeacherPay(actor, s)) {
      throw new ForbiddenException('Bạn không xem được lương giáo viên trường');
    }
    const manager = this.dataSource.manager;
    const rows = await this.loadMonthlyRows(manager, id);
    // Quy trình Kế toán chưa gửi: xem trước cả bảng của trường trong kỳ — số
    // Còn chi lúc này là số sẽ chốt nếu Kế toán gửi ngay.
    if (!rows.length && isAccountantChain(s) && s.schoolId && s.expensePeriodId) {
      return this.previewChainSheet(s, source);
    }
    const refs = rows.map((row) => this.cashflowRefOfRow(row));
    const groups = await this.cashflowGroupsFor(manager, source, refs);
    const { payments } = SUGGEST_PAYMENT_TABLES[source];
    const paid = await manager.query<{ item_id: number; total: string }[]>(
      `SELECT suggest_monthly_item_id AS item_id, SUM(amount)::text AS total
       FROM ${payments} WHERE suggest_id = $1 GROUP BY suggest_monthly_item_id`,
      [id],
    );
    const paidByItem = new Map(paid.map((row) => [Number(row.item_id), Number(row.total)]));
    const items = rows.map((row, index) => {
      const group = groups.get(cashflowItemKey(source, refs[index]));
      const remaining = group?.remainingAmount ?? 0;
      return {
        id: row.id,
        label: monthlyItemLabel(row),
        schoolId: row.schoolId,
        expensePeriodId: row.expensePeriodId,
        subjectId: row.subjectId,
        schoolTeacherId: row.schoolTeacherId,
        requestedAmount: row.requestedAmount,
        approvedAmount: row.approvedAmount,
        excluded: row.excluded,
        spent: row.spent,
        totalAmount: group?.totalAmount ?? 0,
        paidAmount: group?.paidAmount ?? 0,
        remainingAmount: remaining,
        // Chi Ngoài giữ đúng cách tính lệnh chi cũ (tổng Còn chi của bảng).
        amount: source === 'MANAGEMENT' ? remaining : Math.max(0, remaining),
        paidBySuggest: paidByItem.get(row.id) ?? 0,
        status: cashflowItemStatus(
          { paidAmount: group?.paidAmount ?? 0, remainingAmount: remaining },
          null,
        ),
      };
    });
    const remainingTotal =
      Math.round(
        items
          .filter((item) => !item.excluded)
          .reduce((sum, item) => sum + item.amount, 0) * 100,
      ) / 100;
    return { source, table: CASHFLOW_TABLE_LABELS[source], items, remainingTotal };
  }

  /**
   * Khoản của "Đề xuất chi tháng" tích chọn, mỗi khoản theo bảng của nó:
   * Phải chi / Đã chi / Còn lại hiện tại ở QL thu chi, số Kế toán nhập
   * (`requestedAmount`), số Giám đốc duyệt và phần đã ghi về bảng. Người không
   * được xem lương giáo viên trường thì không thấy khoản Chi giáo viên.
   */
  private async salesPickCashflowItems(s: Suggest, actor: AuthUser) {
    const manager = this.dataSource.manager;
    const all = await this.loadMonthlyRows(manager, s.id!);
    const seeTeacher = this.canSeeTeacherPay(actor, s);
    const rows = all.filter(
      (row) => seeTeacher || itemSourceOf(row, s) !== 'SCHOOL_TEACHER',
    );
    const items: Record<string, unknown>[] = [];
    const remainingBy = await this.salesPickRemaining(manager, s, rows);
    for (const source of CASHFLOW_SOURCES) {
      const indexes = rows
        .map((row, index) => (itemSourceOf(row, s) === source ? index : -1))
        .filter((index) => index >= 0);
      if (!indexes.length) continue;
      const refs = indexes.map((index) => this.cashflowRefOfRow(rows[index]));
      const groups = await this.cashflowGroupsFor(manager, source, refs);
      const { payments } = SUGGEST_PAYMENT_TABLES[source];
      const paid = await manager.query<{ item_id: number; total: string }[]>(
        `SELECT suggest_monthly_item_id AS item_id, SUM(amount)::text AS total
         FROM ${payments} WHERE suggest_id = $1 GROUP BY suggest_monthly_item_id`,
        [s.id],
      );
      const paidByItem = new Map(paid.map((row) => [Number(row.item_id), Number(row.total)]));
      indexes.forEach((rowIndex, i) => {
        const row = rows[rowIndex];
        const group = groups.get(cashflowItemKey(source, refs[i]));
        const remaining = group?.remainingAmount ?? 0;
        items.push({
          position: rowIndex,
          id: row.id,
          source,
          sourceLabel: SALES_PICK_SOURCE_LABELS[source],
          table: CASHFLOW_TABLE_LABELS[source],
          label: monthlyItemLabel(row),
          schoolId: row.schoolId,
          expensePeriodId: row.expensePeriodId,
          subjectId: row.subjectId,
          schoolTeacherId: row.schoolTeacherId,
          requestedAmount: row.requestedAmount,
          approvedAmount: row.approvedAmount,
          excluded: row.excluded,
          spent: row.spent,
          totalAmount: group?.totalAmount ?? 0,
          paidAmount: group?.paidAmount ?? 0,
          remainingAmount: remaining,
          inContractAmount: group?.inContractAmount ?? 0,
          // Số vào lệnh chi nếu Giám đốc duyệt bây giờ: số Kế toán nhập.
          amount:
            row.requestedAmount === null || row.requestedAmount === undefined
              ? 0
              : Number(row.requestedAmount),
          maxAmount: remainingBy[rowIndex],
          paidBySuggest: paidByItem.get(row.id) ?? 0,
          status: cashflowItemStatus(
            { paidAmount: group?.paidAmount ?? 0, remainingAmount: remaining },
            null,
          ),
        });
      });
    }
    items.sort((a, b) => Number(a.position) - Number(b.position));
    const remainingTotal = round2(
      items
        .filter((item) => !item.excluded)
        .reduce((sum, item) => sum + Number(item.amount), 0),
    );
    return {
      source: cashflowSourceOf(s),
      table: null,
      salesPick: true,
      salesAmount: s.salesAmount === null || s.salesAmount === undefined ? null : Number(s.salesAmount),
      // Tổng Còn chi hiện tại của các khoản (trần số tiền Kế toán nhập).
      pickedRemainingTotal: round2(remainingBy.reduce((sum, value) => sum + value, 0)),
      hiddenItemCount: all.length - rows.length,
      items: items.map(({ position: _position, ...item }) => item),
      remainingTotal,
    };
  }

  private async previewChainSheet(s: Suggest, source: CashflowSource) {
    const manager = this.dataSource.manager;
    const { groups, unassigned } = await this.sheetGroups(
      manager,
      source,
      s.schoolId!,
      s.expensePeriodId!,
    );
    const open = await loadOpenCashflowRequests(manager, source, [s.schoolId!], s.id!);
    const openByKey = new Map(open.map((request) => [request.key, request]));
    const items = groups.map((group) => {
      const holder = openByKey.get(group.key) ?? null;
      return {
        id: null,
        label: cashflowGroupLabel(group),
        schoolId: group.schoolId,
        expensePeriodId: group.expensePeriodId,
        subjectId: group.subjectId,
        schoolTeacherId: group.schoolTeacherId,
        requestedAmount: null,
        approvedAmount: null,
        excluded: false,
        spent: null,
        totalAmount: group.totalAmount,
        paidAmount: group.paidAmount,
        remainingAmount: group.remainingAmount,
        inContractAmount: group.inContractAmount,
        // Khoản đang nằm trong đề xuất khác sẽ bị bỏ qua khi gửi.
        amount: holder ? 0 : Math.max(0, group.remainingAmount),
        paidBySuggest: 0,
        status: cashflowItemStatus(group, holder),
        openRequest: holder
          ? { id: holder.suggestId, code: holder.code, status: holder.status }
          : null,
      };
    });
    const remainingTotal =
      Math.round(items.reduce((sum, item) => sum + item.amount, 0) * 100) / 100;
    return {
      source,
      table: CASHFLOW_TABLE_LABELS[source],
      items,
      remainingTotal,
      preview: true,
      unassigned,
    };
  }

  async findOneExpense(id: number, actor?: AuthUser) {
    const s = await this.repo.findOne({
      where: { id, type: SuggestType.EXPENSE_REQUEST },
      relations: {
        createdByUser: true,
        paymentOrder: { creator: true },
        stockIssueOrder: { creator: true },
        attachments: true,
        school: true,
        subject: true,
        expensePeriod: true,
        monthlyItems: {
          school: true,
          subject: { catalog: true },
          schoolTeacher: true,
          expensePeriod: true,
        },
        policySupportItems: true,
        assignedTechnician: true,
        stockInOrder: { creator: true, stocker: true, warehouseReceipt: true },
        stockInHandler: true,
        acceptor: true,
        assignments: { employee: true },
      },
      order: {
        assignments: { id: 'ASC' },
        monthlyItems: { position: 'ASC', id: 'ASC' },
        policySupportItems: { id: 'ASC' },
      },
    });

    if (!s) {
      throw new NotFoundException('Đề xuất chi không tồn tại');
    }

    // Người được Giám đốc chỉ định trên đề xuất luôn xem được đề xuất đó, kể
    // cả khi role của họ chỉ cho xem đơn của chính mình.
    const assignedToActor = !!actor && this.isExpenseAssignedTo(s, actor.id);

    if (
      this.isRequesterOnly(actor) &&
      s.createdBy !== actor!.id &&
      !assignedToActor
    ) {
      throw new ForbiddenException('Bạn chỉ được xem đề nghị của chính mình');
    }

    if (
      this.isTechnicalOnly(actor) &&
      !assignedToActor &&
      ![ExpenseRequestKind.EQUIPMENT, ExpenseRequestKind.REPAIR].includes(
        s.requestKind as ExpenseRequestKind,
      )
    ) {
      throw new ForbiddenException(
        'Phòng kỹ thuật chỉ xem được đề xuất thiết bị hoặc sửa chữa',
      );
    }

    if (
      this.isTechnicalOnly(actor) &&
      s.assignedTechnicianId != null &&
      !assignedToActor
    ) {
      throw new ForbiddenException(
        'Đề xuất này đã được giao cho một nhân viên kỹ thuật khác',
      );
    }

    const logs = await this.historyRepo.find({
      where: { suggestId: id },
      order: { snapshotAt: 'ASC' },
    });

    const actorIds = [...new Set(logs.map((l) => l.userId).filter(Boolean))];
    const actors = actorIds.length
      ? await this.employeeRepo.findBy({ id: In(actorIds) })
      : [];
    const actorNameById = new Map(actors.map((a) => [a.id, a.name]));
    // Bảng Chi Ngoài theo đúng quyền đọc của Quản lý thu chi: người lập đề xuất
    // vẫn xem được lịch sử nhưng không thấy ảnh chụp số liệu này.
    const canReadCashflow = actor?.roles?.some((role) =>
      (CASHFLOW_READ_ROLES as readonly string[]).includes(role),
    );
    // Đề xuất Chi GV trường: lương từng giáo viên chỉ chủ đề xuất và nhóm xem
    // lương ở QL thu chi thấy (Sales Admin thì không, như màn QL thu chi).
    // Lời gọi nội bộ (không có người xem, vd. trả kết quả sau khi chủ đơn tạo/sửa) không ẩn.
    const hasTeacherItems = isSalesPick(s)
      ? (s.monthlyItems ?? []).some((item) => itemSourceOf(item, s) === 'SCHOOL_TEACHER')
      : cashflowSourceOf(s) === 'SCHOOL_TEACHER';
    const hideTeacherPay =
      !!actor && hasTeacherItems && !this.canSeeTeacherPay(actor, s);
    const enrichedLogs = logs.map((l) => {
      let data = (l.data ?? {}) as Record<string, unknown>;
      if (!canReadCashflow) {
        const { managementExpense: _hidden, ...rest } = data;
        data = rest;
      }
      if (hideTeacherPay) {
        // Số tiền từng giáo viên lúc duyệt / chi một phần / ghi vào bảng.
        const {
          items: _items,
          cashflowPayment: _payment,
          cashflowPayments: _payments,
          partialSpend: _partial,
          pickedItems: _picked,
          droppedItems: _dropped,
          ...rest
        } = data;
        data = rest;
      }
      return {
        ...l,
        data: l.data ? data : l.data,
        actorName: l.userId ? actorNameById.get(l.userId) : undefined,
      };
    });

    if (hideTeacherPay) {
      s.monthlyItems = (s.monthlyItems ?? []).map((item) =>
        isSalesPick(s) && itemSourceOf(item, s) !== 'SCHOOL_TEACHER'
          ? item
          : { ...item, approvedAmount: null, requestedAmount: null },
      );
    }
    return { ...s, logs: enrichedLogs };
  }

  /**
   * "Việc cần làm của tôi" cho luồng đề xuất chi — theo role hiện tại:
   * - director:       PENDING_APPROVAL
   * - saleadmin:      PENDING_APPROVAL (chưa kiểm duyệt)
   * - ketoan_congno:  APPROVED, FUND_RETURNED
   * - thuquy:         PAYMENT_ORDERED, NOT_SPENT (đề xuất tiền)
   * - ky_thuat:       việc thiết bị và đề xuất sửa chữa chờ phản hồi
   * - sales (chủ):    DRAFT, CASH_RELEASED, CASH_RECEIVED,
   *                   STOCK_ISSUE_ORDERED, EQUIPMENT_RECEIVED
   * - bất kỳ ai:      thiết bị từ nhà cung cấp mình được chỉ định xử lý (APPROVED) hoặc
   *                   nghiệm thu (STOCK_IN_COMPLETED)
   */
  async myExpenseTasks(user: AuthUser) {
    const actor = this.ensureUser(user);
    const roles = actor.roles ?? [];

    const qb = this.repo
      .createQueryBuilder('s')
      .leftJoinAndSelect('s.createdByUser', 'creator')
      .leftJoinAndSelect('s.paymentOrder', 'po')
      .leftJoinAndSelect('s.stockIssueOrder', 'sio')
      .leftJoinAndSelect('s.stockInOrder', 'sino')
      .leftJoinAndSelect('s.school', 'school')
      .leftJoinAndSelect('s.subject', 'subject')
      .leftJoinAndSelect('s.expensePeriod', 'expensePeriod')
      .leftJoinAndSelect('s.monthlyItems', 'monthlyItem')
      .leftJoinAndSelect('monthlyItem.school', 'monthlyItemSchool')
      .where('s.type = :type', { type: SuggestType.EXPENSE_REQUEST });

    const conditions: string[] = [];
    const params: Record<string, any> = {};
    params.meId = actor.id;

    /**
     * Các bước kiểm soát đều cấm chính người tạo đề xuất
     * (`assertExpenseTransition`), nên phải loại đề xuất của chính mình khỏi
     * danh sách việc cần làm. Không loại thì người kiêm nhiệm — ví dụ vừa
     * `sales` vừa `thuquy` — thấy đề xuất của chính mình nằm trong danh sách,
     * bấm vào rồi nhận 403.
     */
    const notMine = (condition: string) => `(s.createdBy != :meId AND ${condition})`;

    if (roles.includes(ExpenseRole.DIRECTOR)) {
      conditions.push(notMine('s.status = :dirStatus'));
      params.dirStatus = SuggestStatus.PENDING_APPROVAL;
    }
    // Có người bàn giao/hỗ trợ từ chối, chờ chọn người thay thế.
    if (
      roles.includes(ExpenseRole.DIRECTOR) ||
      roles.includes(ExpenseRole.SALES_ADMIN)
    ) {
      conditions.push(`EXISTS (
        SELECT 1 FROM suggest_assignment sa
        WHERE sa."suggestId" = s.id AND sa.status = :declinedAssignment
      )`);
      params.declinedAssignment = AssignmentStatus.DECLINED;
    }
    if (roles.includes(ExpenseRole.SALES_ADMIN)) {
      // Sales Admin giờ duyệt/từ chối được ngang quyền Giám đốc nên vẫn còn
      // việc kể cả khi đã kiểm duyệt chính sách xong — không lọc theo
      // `saleadminReviewStatus` nữa.
      conditions.push(
        notMine('s.status = :saStatus AND s.isMonthlyExpense = false'),
      );
      params.saStatus = SuggestStatus.PENDING_APPROVAL;
    }
    if (roles.includes(ExpenseRole.CHIEF_ACCOUNTANT)) {
      // Kế toán trưởng cũng duyệt/từ chối được ngang Giám đốc & Sales Admin.
      conditions.push(
        notMine('s.status = :caStatus AND s.isMonthlyExpense = false'),
      );
      params.caStatus = SuggestStatus.PENDING_APPROVAL;
    }
    // Quy trình Kế toán của Chi Ngoài / Chi Trường / Chi GV trường.
    if (
      roles.includes(ExpenseRole.ACCOUNTANT) ||
      roles.includes(ExpenseRole.CHIEF_ACCOUNTANT)
    ) {
      conditions.push(notMine('s.status = :accountantInputStatus'));
      params.accountantInputStatus = SuggestStatus.PENDING_ACCOUNTANT;
    } else if (roles.includes(ExpenseRole.DEBT_ACCOUNTANT)) {
      // "Đề xuất chi tháng" tích chọn: Kế toán công nợ cũng nhập số tiền được.
      conditions.push(
        notMine('s.status = :accountantInputStatus AND s.approvalFlow = :salesPickFlow'),
      );
      params.accountantInputStatus = SuggestStatus.PENDING_ACCOUNTANT;
      params.salesPickFlow = SALES_PICK;
    }
    if (roles.includes(ExpenseRole.CHIEF_ACCOUNTANT)) {
      conditions.push(notMine('s.status = :chiefApprovalStatus'));
      params.chiefApprovalStatus = SuggestStatus.PENDING_CHIEF_APPROVAL;
    }
    // Kế toán & thủ quỹ chỉ giữ nhánh tiền, phòng kỹ thuật chỉ giữ nhánh
    // thiết bị. `APPROVED` và `NOT_SPENT` dùng chung cho cả hai nhánh nên
    // phải lọc thêm theo `requestKind`, không thì kế toán thấy cả đề xuất
    // thiết bị rồi bấm vào nhận 409.
    params.cashKind = ExpenseRequestKind.CASH;
    params.equipmentKind = ExpenseRequestKind.EQUIPMENT;
    params.repairKind = ExpenseRequestKind.REPAIR;

    // Kế toán trưởng có toàn quyền kế toán công nợ + thủ quỹ nên phải thấy
    // việc của cả hai nhánh, không chỉ nhánh khớp đúng role của mình.
    if (
      roles.includes(ExpenseRole.DEBT_ACCOUNTANT) ||
      roles.includes(ExpenseRole.CHIEF_ACCOUNTANT)
    ) {
      conditions.push(
        notMine(
          `s.requestKind = :cashKind AND (
            s.status IN (:...accStatuses)
            OR (s.isMonthlyExpense = true AND s.status = :pendingAccounting)
          )`,
        ),
      );
      params.accStatuses = [
        SuggestStatus.APPROVED,
        SuggestStatus.FUND_RETURNED,
      ];
      params.pendingAccounting = SuggestStatus.PENDING_ACCOUNTING;
    }
    if (
      roles.includes(ExpenseRole.TREASURER) ||
      roles.includes(ExpenseRole.CHIEF_ACCOUNTANT)
    ) {
      conditions.push(
        notMine(
          's.requestKind = :cashKind AND s.status IN (:...treStatuses)',
        ),
      );
      params.treStatuses = [
        SuggestStatus.PAYMENT_ORDERED,
        SuggestStatus.NOT_SPENT,
        SuggestStatus.PARTIALLY_SPENT,
      ];
    }
    if (roles.includes(ExpenseRole.TECHNICAL)) {
      conditions.push(
        notMine(
          `(
            (
              s.requestKind = :equipmentKind
              AND s.status IN (:...techEquipmentStatuses)
              AND (s.equipmentSource IS NULL OR s.equipmentSource = :stockSource)
            )
            OR (
              s.requestKind = :repairKind
              AND s.status = :techRepairStatus
            )
          ) AND (
            s.assignedTechnicianId IS NULL
            OR s.assignedTechnicianId = :meId
          )`,
        ),
      );
      params.techEquipmentStatuses = [
        SuggestStatus.APPROVED,
        SuggestStatus.EQUIPMENT_RETURNED,
        SuggestStatus.NOT_SPENT,
      ];
      params.techRepairStatus = SuggestStatus.APPROVED;
      params.stockSource = EquipmentSource.STOCK;
    }
    if (roles.some((role) => EXPENSE_REQUESTER_ROLES.includes(role))) {
      conditions.push(
        '(s.createdBy = :meId AND s.status IN (:...saleStatuses))',
      );
      params.saleStatuses = [
        SuggestStatus.CASH_RELEASED,
        SuggestStatus.CASH_RECEIVED,
        SuggestStatus.STOCK_ISSUE_ORDERED,
        SuggestStatus.EQUIPMENT_RECEIVED,
      ];
    }

    // Thiết bị từ nhà cung cấp: việc theo người được Giám đốc chỉ định, không
    // theo role — ai được chọn làm người xử lý/nghiệm thu đều thấy, kể cả chủ
    // đề xuất.
    conditions.push(
      `(
        s.requestKind = :equipmentKind
        AND s.equipmentSource = :supplierSource
        AND (
          (s.status = :purchaseHandlerStatus AND s.stockInHandlerId = :meId)
          OR (s.status = :purchaseAcceptorStatus AND s.acceptorId = :meId)
        )
      )`,
    );
    params.equipmentKind = ExpenseRequestKind.EQUIPMENT;
    params.supplierSource = EquipmentSource.SUPPLIER;
    params.purchaseHandlerStatus = SuggestStatus.APPROVED;
    params.purchaseAcceptorStatus = SuggestStatus.STOCK_IN_COMPLETED;

    if (conditions.length === 0) return [];

    return qb
      .andWhere(`(${conditions.join(' OR ')})`, params)
      .orderBy('s.isOverdue', 'DESC')
      .addOrderBy('s.expectedPaymentDate', 'ASC')
      .getMany();
  }

  // ================= REMINDER SETTINGS =================

  async getRemindBeforeDays(): Promise<number> {
    const setting = await this.settingRepo.findOne({
      where: { key: REMIND_BEFORE_DAYS_KEY },
    });
    const parsed = setting ? parseInt(setting.value, 10) : NaN;
    return Number.isNaN(parsed) ? DEFAULT_REMIND_BEFORE_DAYS : parsed;
  }

  async updateRemindBeforeDays(days: number) {
    await this.settingRepo.upsert(
      { key: REMIND_BEFORE_DAYS_KEY, value: String(days) },
      ['key'],
    );
    return { remindBeforeDays: days };
  }

  async getExpenseRemindersEnabled(): Promise<boolean> {
    const setting = await this.settingRepo.findOne({
      where: { key: EXPENSE_REMINDERS_ENABLED_KEY },
    });
    if (!setting) return DEFAULT_EXPENSE_REMINDERS_ENABLED;
    return setting.value === 'true';
  }

  async getExpenseReminderSettings() {
    const [remindBeforeDays, enabled] = await Promise.all([
      this.getRemindBeforeDays(),
      this.getExpenseRemindersEnabled(),
    ]);
    return { remindBeforeDays, enabled };
  }

  async updateExpenseReminderSettings(settings: {
    remindBeforeDays?: number;
    enabled?: boolean;
  }) {
    const rows: Array<Pick<SuggestReminderSetting, 'key' | 'value'>> = [];
    if (settings.remindBeforeDays !== undefined) {
      rows.push({
        key: REMIND_BEFORE_DAYS_KEY,
        value: String(settings.remindBeforeDays),
      });
    }
    if (settings.enabled !== undefined) {
      rows.push({
        key: EXPENSE_REMINDERS_ENABLED_KEY,
        value: String(settings.enabled),
      });
    }
    if (rows.length) await this.settingRepo.upsert(rows, ['key']);
    return this.getExpenseReminderSettings();
  }

  // ================= CRON BÁO ĐỘNG (08:00 giờ VN) =================

  @Cron('0 8 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleExpenseReminders() {
    // dev (sales-be) và prod chạy chung DB, mỗi process tự đăng ký cron
    // riêng — không chặn thì nhắc bị gửi trùng mỗi ngày. Xem is-cron-leader.ts.
    if (!isCronLeader()) return;
    try {
      const result = await this.runExpenseReminders();
      this.logger.log(
        `Expense reminders: upcoming=${result.upcoming}, ` +
          `dueToday=${result.dueToday}, overdue=${result.overdue}`,
      );
    } catch (error) {
      this.logger.error('Expense reminder job failed', error as any);
    }
  }

  async runExpenseReminders() {
    const enabled = await this.getExpenseRemindersEnabled();
    if (!enabled) {
      return { enabled: false, upcoming: 0, dueToday: 0, overdue: 0 };
    }

    const today = vnToday();
    const remindBeforeDays = await this.getRemindBeforeDays();

    const requests = await this.repo.find({
      where: {
        type: SuggestType.EXPENSE_REQUEST,
        status: Not(In(EXPENSE_TERMINAL_STATUSES)),
      },
    });

    const counters = { upcoming: 0, dueToday: 0, overdue: 0 };

    for (const s of requests) {
      if (!s.expectedPaymentDate) continue;

      const d = diffDays(s.expectedPaymentDate, today);

      if (d > 0 && d <= remindBeforeDays) {
        counters.upcoming += await this.remindUpcoming(s, d);
      } else if (d === 0) {
        counters.dueToday += await this.remindDueToday(s);
      } else if (d < 0) {
        counters.overdue += await this.remindOverdue(s, -d);
      }
    }

    return { enabled: true, ...counters };
  }

  private async remindUpcoming(s: Suggest, daysLeft: number) {
    let roles: string[] = [];
    let userIds: number[] = [];
    let message = '';

    if (s.status === SuggestStatus.PENDING_ACCOUNTING) {
      roles = [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT];
      message =
        `Đề xuất chi tháng ${s.code} dự kiến chi trong ${daysLeft} ngày` +
        ` (${s.expectedPaymentDate}) nhưng Kế toán công nợ chưa nhập số tiền`;
    } else if (s.status === SuggestStatus.PENDING_APPROVAL) {
      roles = [ExpenseRole.DIRECTOR];
      message =
        `Đề xuất ${s.code} dự kiến chi trong ${daysLeft} ngày` +
        ` (${s.expectedPaymentDate}) nhưng chưa được duyệt`;
    } else if (s.status === SuggestStatus.APPROVED) {
      // Đã duyệt nhưng chưa sang bước kế: tiền chờ kế toán; thiết bị/sửa chữa
      // chờ phòng kỹ thuật (hoặc đúng người được chỉ định).
      const isEquipment = s.requestKind === ExpenseRequestKind.EQUIPMENT;
      const isRepair = s.requestKind === ExpenseRequestKind.REPAIR;
      const isPurchase =
        isEquipment && s.equipmentSource === EquipmentSource.SUPPLIER;
      const needsTechnical = (isEquipment && !isPurchase) || isRepair;
      roles = isPurchase
        ? []
        : needsTechnical
        ? s.assignedTechnicianId
          ? []
          : [ExpenseRole.TECHNICAL]
        : [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.CHIEF_ACCOUNTANT];
      userIds = isPurchase
        ? s.stockInHandlerId
          ? [s.stockInHandlerId]
          : []
        : needsTechnical && s.assignedTechnicianId
          ? [s.assignedTechnicianId]
          : [];
      const expectedAction = isRepair
        ? 'phản hồi nhận việc'
        : isPurchase
          ? 'phiếu nhập kho'
          : isEquipment
          ? 'lệnh xuất kho'
          : 'lệnh chi';
      message =
        `Đề xuất ${s.code} đến hạn trong ${daysLeft} ngày` +
        ` (${s.expectedPaymentDate}) nhưng chưa có ${expectedAction}`;
    } else {
      return 0;
    }

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '⏰ Sắp đến ngày chi',
        message,
        meta: { kind: 'reminder', status: s.status },
      },
      { roles, userIds },
    );

    return 1;
  }

  private async remindDueToday(s: Suggest) {
    const actor = expenseActorForStatus(
      s.status as SuggestStatus,
      s.requestKind ?? ExpenseRequestKind.CASH,
      s.equipmentSource,
      s.isMonthlyExpense,
      s.approvalFlow,
    );
    if (!actor) return 0;
    const assignedTechnical =
      !actor.owner &&
      actor.roles.includes(ExpenseRole.TECHNICAL) &&
      s.assignedTechnicianId
        ? s.assignedTechnicianId
        : null;

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '📅 Hôm nay là ngày mong muốn',
        message:
          `Hôm nay là ngày mong muốn của đề xuất ${s.code}` +
          ` (đang ở bước ${s.status})`,
        meta: { kind: 'due_today', status: s.status },
      },
      {
        roles: [
          ...(!actor.owner && !assignedTechnical ? actor.roles : []),
          ExpenseRole.DIRECTOR,
        ],
        userIds: [
          ...(actor.owner && s.createdBy ? [s.createdBy] : []),
          ...(assignedTechnical ? [assignedTechnical] : []),
          ...(actor.assignee && this.expenseAssigneeId(s, actor.assignee)
            ? [this.expenseAssigneeId(s, actor.assignee)!]
            : []),
        ],
      },
    );

    return 1;
  }

  private async remindOverdue(s: Suggest, daysLate: number) {
    if (!s.isOverdue) {
      await this.repo.update(s.id!, { isOverdue: true });
    }

    // Đã tắt nhắc riêng cho đề xuất này — vẫn đánh dấu quá hạn ở trên để các
    // màn khác hiển thị đúng trạng thái, chỉ bỏ qua việc gửi thông báo.
    if (s.overdueAlertMuted) return 0;

    const actor = expenseActorForStatus(
      s.status as SuggestStatus,
      s.requestKind ?? ExpenseRequestKind.CASH,
      s.equipmentSource,
      s.isMonthlyExpense,
      s.approvalFlow,
    );
    if (!actor) return 0;
    const assignedTechnical =
      !actor.owner &&
      actor.roles.includes(ExpenseRole.TECHNICAL) &&
      s.assignedTechnicianId
        ? s.assignedTechnicianId
        : null;

    await this.notifyExpense(
      {
        suggestId: s.id!,
        title: '🚨 Đề xuất quá hạn',
        message:
          `Đề xuất ${s.code} đã quá ngày mong muốn ${daysLate} ngày` +
          ` (${s.expectedPaymentDate}), đang ở bước ${s.status}`,
        meta: { kind: 'overdue', status: s.status, daysLate },
      },
      {
        roles: [
          ...(!actor.owner && !assignedTechnical ? actor.roles : []),
          ExpenseRole.DIRECTOR,
        ],
        userIds: [
          ...(actor.owner && s.createdBy ? [s.createdBy] : []),
          ...(assignedTechnical ? [assignedTechnical] : []),
          ...(actor.assignee && this.expenseAssigneeId(s, actor.assignee)
            ? [this.expenseAssigneeId(s, actor.assignee)!]
            : []),
        ],
      },
    );

    return 1;
  }

  /**
   * Tắt/bật nhắc quá hạn cho riêng một đề xuất — dùng khi Giám đốc đã biết và
   * đang xử lý, không cần bị nhắc lại mỗi ngày nữa. Không ảnh hưởng đề xuất
   * khác, và không tắt cron chung (`reminder-settings`).
   */
  async setOverdueAlertMuted(id: number, muted: boolean) {
    const suggest = await this.repo.findOne({ where: { id } });
    if (!suggest || suggest.type !== SuggestType.EXPENSE_REQUEST) {
      throw new NotFoundException('Không tìm thấy đề xuất chi');
    }

    await this.repo.update(id, { overdueAlertMuted: muted });
    return { id, overdueAlertMuted: muted };
  }
}
