import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { CashAccount } from '../cashflow-report/cash-account.entity';
import { Payroll } from '../payroll/entities/payroll.entity';
import { AuthUser } from '../type/auth-user.type';
import {
  BalanceQueryDto,
  ConfirmDeductionDto,
  MoneyMovementDto,
  ReasonDto,
} from './dto/financial-action.dto';
import {
  AvailableAdvancesQueryDto,
  DeductionQueryDto,
} from './dto/financial-request.dto';
import { FinancialAdvanceAllocation } from './entities/financial-advance-allocation.entity';
import { FinancialPayment } from './entities/financial-payment.entity';
import { FinancialRefund } from './entities/financial-refund.entity';
import { FinancialRequestItem } from './entities/financial-request-item.entity';
import { FinancialRequestSupplier } from './entities/financial-request-supplier.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { FinancialSalaryAdvanceDeduction } from './entities/financial-salary-advance-deduction.entity';
import {
  advanceAvailable,
  computeAdvanceSettlementStatus,
  computeDeductionStatus,
  computePaymentStatus,
  computeSettlement,
  nextPeriod,
  periodKey,
  vnToday,
} from './financial-calculations';
import {
  FinanceContext,
  FinancialAccessService,
} from './financial-access.service';
import { FinancialNotifyService, writeAudit } from './financial-notify.service';
import {
  ACTIVE_APPROVAL_STATUSES,
  ApprovalStatus,
  AuditAction,
  DeductionRowStatus,
  FinanceRole,
  FinancialRequestType,
  MovementStatus,
  PaymentMethod,
  RecoveryStatus,
  SettlementStatus,
} from './financial-request.constants';
import { paymentAccountGroup } from './financial-payment-account';
import { recipientTotals } from './financial-suppliers';
import {
  formatVnd,
  requireText,
  splitEvenly,
  sumMoney,
} from './financial-money';

/** Số tiền công ty phải chi cho phiếu đã duyệt (tổng nghĩa vụ, chưa trừ đã chi). */
export function payableDue(request: FinancialRequest): number {
  if (request.approvalStatus !== ApprovalStatus.APPROVED) return 0;
  const approved = request.approvedAmount ?? 0;
  if (request.type === FinancialRequestType.SETTLEMENT) {
    return Math.max(approved - request.offsetAmount, 0);
  }
  return approved;
}

/** Số tiền nhân viên phải hoàn trả (chỉ phiếu hoàn ứng có chi phí < tạm ứng). */
export function receivableDue(request: FinancialRequest): number {
  if (
    request.approvalStatus !== ApprovalStatus.APPROVED ||
    request.type !== FinancialRequestType.SETTLEMENT
  ) {
    return 0;
  }
  return Math.max(request.offsetAmount - (request.approvedAmount ?? 0), 0);
}

@Injectable()
export class FinancialLedgerService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly access: FinancialAccessService,
    private readonly notifier: FinancialNotifyService,
    @InjectRepository(FinancialRequest)
    private readonly requestRepo: Repository<FinancialRequest>,
    @InjectRepository(FinancialAdvanceAllocation)
    private readonly allocationRepo: Repository<FinancialAdvanceAllocation>,
    @InjectRepository(FinancialSalaryAdvanceDeduction)
    private readonly deductionRepo: Repository<FinancialSalaryAdvanceDeduction>,
  ) {}

  // ---------------------------------------------------------------------------
  // Khoá & nạp
  // ---------------------------------------------------------------------------

  async lockRequest(
    manager: EntityManager,
    id: number,
  ): Promise<FinancialRequest> {
    const request = await manager.getRepository(FinancialRequest).findOne({
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!request || request.deletedAt) {
      throw new NotFoundException('Không tìm thấy chứng từ');
    }
    return request;
  }

  /** Khoá nhiều phiếu theo thứ tự id tăng dần để tránh deadlock. */
  async lockRequests(manager: EntityManager, ids: number[]) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    const result = new Map<number, FinancialRequest>();
    for (const id of sorted)
      result.set(id, await this.lockRequest(manager, id));
    return result;
  }

  // ---------------------------------------------------------------------------
  // Phân bổ tạm ứng ↔ hoàn ứng
  // ---------------------------------------------------------------------------

  /**
   * Số đã bị các phiếu hoàn ứng KHÁC đang hoạt động (chờ duyệt / trả về / đã
   * duyệt) giữ chỗ trên từng phiếu tạm ứng.
   */
  async reservedByOthers(
    manager: EntityManager,
    advanceIds: number[],
    excludeSettlementId?: number,
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (!advanceIds.length) return map;
    const qb = manager
      .getRepository(FinancialAdvanceAllocation)
      .createQueryBuilder('a')
      .innerJoin(FinancialRequest, 's', 's.id = a.settlement_id')
      .select('a.advance_id', 'advanceId')
      .addSelect('COALESCE(SUM(a.amount), 0)', 'reserved')
      .where('a.advance_id IN (:...advanceIds)', { advanceIds })
      .andWhere('s.deleted_at IS NULL')
      .andWhere('s.approval_status IN (:...active)', {
        active: ACTIVE_APPROVAL_STATUSES,
      })
      .groupBy('a.advance_id');
    if (excludeSettlementId) {
      qb.andWhere('a.settlement_id <> :exclude', {
        exclude: excludeSettlementId,
      });
    }
    for (const row of await qb.getRawMany<{
      advanceId: number;
      reserved: string;
    }>()) {
      map.set(Number(row.advanceId), Number(row.reserved));
    }
    return map;
  }

  /**
   * Kiểm tra danh sách phân bổ của một phiếu hoàn ứng. `lock` = khoá các phiếu
   * tạm ứng (dùng khi gửi duyệt / duyệt) để hai phiếu hoàn ứng chạy song song
   * không cùng đối trừ một số dư.
   */
  async validateAllocations(
    manager: EntityManager,
    settlement: Pick<FinancialRequest, 'id' | 'requesterId' | 'companyId'>,
    allocations: { advanceId: number; amount: number }[],
    { lock = false }: { lock?: boolean } = {},
  ) {
    const ids = allocations.map((a) => a.advanceId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException('Mỗi phiếu tạm ứng chỉ chọn một lần');
    }
    if (!ids.length) return new Map<number, FinancialRequest>();
    const advances = lock
      ? await this.lockRequests(manager, ids)
      : new Map(
          (
            await manager.getRepository(FinancialRequest).find({
              where: { id: In(ids) },
            })
          ).map((r) => [r.id, r]),
        );
    const reserved = await this.reservedByOthers(manager, ids, settlement.id);
    for (const allocation of allocations) {
      const advance = advances.get(allocation.advanceId);
      if (!advance || advance.deletedAt) {
        throw new BadRequestException(
          `Không tìm thấy phiếu tạm ứng #${allocation.advanceId}`,
        );
      }
      if (advance.type !== FinancialRequestType.ADVANCE) {
        throw new BadRequestException(
          `${advance.code} không phải phiếu tạm ứng`,
        );
      }
      if (advance.requesterId !== settlement.requesterId) {
        throw new BadRequestException(
          `${advance.code} không phải tạm ứng của người đề nghị`,
        );
      }
      if (advance.companyId !== settlement.companyId) {
        throw new BadRequestException(`${advance.code} thuộc công ty khác`);
      }
      if (
        advance.approvalStatus !== ApprovalStatus.APPROVED ||
        advance.paidAmount <= 0
      ) {
        throw new BadRequestException(`${advance.code} chưa được chi tiền`);
      }
      const available = advanceAvailable(
        advance.paidAmount,
        reserved.get(advance.id) ?? 0,
      );
      if (allocation.amount > available) {
        throw new BadRequestException(
          `${advance.code}: số đối trừ ${formatVnd(allocation.amount)} đ vượt số dư còn được hoàn ứng ${formatVnd(available)} đ`,
        );
      }
    }
    return advances;
  }

  /** Phiếu tạm ứng còn số dư của người đề nghị — cho form hoàn ứng. */
  async availableAdvances(user: AuthUser, query: AvailableAdvancesQueryDto) {
    const ctx = await this.access.context(user);
    const advances = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .andWhere('r.type = :type', { type: FinancialRequestType.ADVANCE })
      .andWhere('r.requester_id = :uid', { uid: ctx.userId })
      .andWhere('r.company_id = :companyId', { companyId: query.companyId })
      .andWhere('r.approval_status = :approved', {
        approved: ApprovalStatus.APPROVED,
      })
      .andWhere('r.paid_amount > 0')
      .orderBy('r.request_date', 'ASC')
      .getMany();
    const reserved = await this.reservedByOthers(
      this.dataSource.manager,
      advances.map((a) => a.id),
      query.excludeSettlementId,
    );
    const current = query.excludeSettlementId
      ? await this.allocationRepo.find({
          where: { settlementId: query.excludeSettlementId },
        })
      : [];
    return advances
      .map((advance) => {
        const reservedOther = reserved.get(advance.id) ?? 0;
        return {
          id: advance.id,
          code: advance.code,
          title: advance.title,
          requestDate: advance.requestDate,
          settlementDueDate: advance.settlementDueDate,
          paidAmount: advance.paidAmount,
          settledAmount: advance.settledAmount,
          allocatedElsewhere: reservedOther,
          available: advanceAvailable(advance.paidAmount, reservedOther),
          currentAllocation:
            current.find((c) => c.advanceId === advance.id)?.amount ?? 0,
        };
      })
      .filter((row) => row.available > 0 || row.currentAllocation > 0);
  }

  /**
   * Phiếu hoàn ứng vừa duyệt xong: ghi nhận phân bổ vào các phiếu tạm ứng và
   * tính chênh lệch. Tạm ứng chỉ "tất toán" khi không còn tiền thừa treo.
   */
  async applySettlement(
    manager: EntityManager,
    settlement: FinancialRequest,
    actor: { id: number; name: string },
  ) {
    const allocations = await manager
      .getRepository(FinancialAdvanceAllocation)
      .find({ where: { settlementId: settlement.id } });
    const advances = await this.validateAllocations(
      manager,
      settlement,
      allocations.map((a) => ({ advanceId: a.advanceId, amount: a.amount })),
      { lock: true },
    );
    const now = new Date();
    for (const allocation of allocations) {
      allocation.appliedAt = now;
      await manager.getRepository(FinancialAdvanceAllocation).save(allocation);
      const advance = advances.get(allocation.advanceId)!;
      advance.settledAmount += allocation.amount;
    }
    settlement.offsetAmount = sumMoney(allocations.map((a) => a.amount));
    this.refreshSettlementStatus(settlement);
    await manager.getRepository(FinancialRequest).save(settlement);
    for (const advance of advances.values()) {
      await this.refreshAdvanceStatus(manager, advance);
      await manager.getRepository(FinancialRequest).save(advance);
    }
    await writeAudit(manager, {
      requestId: settlement.id,
      action: AuditAction.ALLOCATION_APPLIED,
      actorId: actor.id,
      actorName: actor.name,
      changes: {
        allocations: allocations.map((a) => ({
          advanceId: a.advanceId,
          advanceCode: advances.get(a.advanceId)?.code,
          amount: a.amount,
        })),
        difference: (settlement.approvedAmount ?? 0) - settlement.offsetAmount,
      },
    });
  }

  /** Huỷ ghi nhận phân bổ khi phiếu hoàn ứng đã duyệt bị huỷ. */
  async revertSettlement(manager: EntityManager, settlement: FinancialRequest) {
    const allocations = await manager
      .getRepository(FinancialAdvanceAllocation)
      .find({ where: { settlementId: settlement.id } });
    const advances = await this.lockRequests(
      manager,
      allocations.map((a) => a.advanceId),
    );
    for (const allocation of allocations) {
      if (!allocation.appliedAt) continue;
      const advance = advances.get(allocation.advanceId)!;
      advance.settledAmount = Math.max(
        advance.settledAmount - allocation.amount,
        0,
      );
      allocation.appliedAt = null;
      await manager.getRepository(FinancialAdvanceAllocation).save(allocation);
    }
    for (const advance of advances.values()) {
      await this.refreshAdvanceStatus(manager, advance, settlement.id);
      await manager.getRepository(FinancialRequest).save(advance);
    }
  }

  refreshSettlementStatus(settlement: FinancialRequest) {
    const result = computeSettlement({
      approvedTotal: settlement.approvedAmount ?? 0,
      offsetTotal: settlement.offsetAmount,
      paidTotal: settlement.paidAmount,
      recoveredTotal: settlement.recoveredAmount,
    });
    settlement.paymentStatus = result.paymentStatus;
    settlement.recoveryStatus = result.recoveryStatus;
    settlement.settlementStatus = result.settlementStatus;
    settlement.completedAt =
      result.settlementStatus === SettlementStatus.COMPLETED
        ? (settlement.completedAt ?? new Date())
        : null;
    return result;
  }

  /** Cập nhật trạng thái quyết toán của một phiếu tạm ứng (đã khoá). */
  async refreshAdvanceStatus(
    manager: EntityManager,
    advance: FinancialRequest,
    ignoreSettlementId?: number,
  ) {
    const pendingRefund = await manager
      .getRepository(FinancialAdvanceAllocation)
      .createQueryBuilder('a')
      .innerJoin(FinancialRequest, 's', 's.id = a.settlement_id')
      .where('a.advance_id = :id', { id: advance.id })
      .andWhere('a.applied_at IS NOT NULL')
      .andWhere('s.settlement_status = :pending', {
        pending: SettlementStatus.PENDING_REFUND,
      })
      .andWhere(ignoreSettlementId ? 's.id <> :ignore' : 'TRUE', {
        ignore: ignoreSettlementId,
      })
      .getCount();
    advance.paymentStatus = computePaymentStatus(
      advance.approvedAmount ?? 0,
      advance.paidAmount,
    );
    advance.settlementStatus = computeAdvanceSettlementStatus({
      paid: advance.paidAmount,
      applied: advance.settledAmount,
      hasPendingRefund: pendingRefund > 0,
    });
    advance.completedAt =
      advance.settlementStatus === SettlementStatus.SETTLED
        ? (advance.completedAt ?? new Date())
        : null;
  }

  /** Cập nhật các phiếu tạm ứng liên quan khi phiếu hoàn ứng đổi trạng thái thu hồi. */
  private async refreshLinkedAdvances(
    manager: EntityManager,
    settlementId: number,
  ) {
    const allocations = await manager
      .getRepository(FinancialAdvanceAllocation)
      .find({ where: { settlementId } });
    const advances = await this.lockRequests(
      manager,
      allocations.filter((a) => a.appliedAt).map((a) => a.advanceId),
    );
    for (const advance of advances.values()) {
      await this.refreshAdvanceStatus(manager, advance);
      await manager.getRepository(FinancialRequest).save(advance);
    }
  }

  // ---------------------------------------------------------------------------
  // Chi tiền / thu hồi
  // ---------------------------------------------------------------------------

  private async assertCashAccount(
    manager: EntityManager,
    code?: string,
    method?: PaymentMethod,
  ) {
    if (!code) return null;
    const account = await manager
      .getRepository(CashAccount)
      .findOne({ where: { code } });
    if (!account || !account.isActive) {
      throw new BadRequestException(`Tài khoản tiền "${code}" không hợp lệ`);
    }
    if (method && account.groupCode !== paymentAccountGroup(method)) {
      throw new BadRequestException(
        method === PaymentMethod.CASH
          ? 'Chi/thu tiền mặt chỉ được dùng tài khoản nhóm 111'
          : 'Chi/thu chuyển khoản chỉ được dùng tài khoản nhóm 112',
      );
    }
    return code;
  }

  /** Cập nhật trạng thái sau khi số đã chi thay đổi. */
  private async afterPaidChanged(
    manager: EntityManager,
    request: FinancialRequest,
  ) {
    switch (request.type) {
      case FinancialRequestType.SETTLEMENT:
        this.refreshSettlementStatus(request);
        break;
      case FinancialRequestType.ADVANCE:
        await this.refreshAdvanceStatus(manager, request);
        break;
      case FinancialRequestType.SALARY_ADVANCE:
        request.paymentStatus = computePaymentStatus(
          request.approvedAmount ?? 0,
          request.paidAmount,
        );
        request.deductionStatus = computeDeductionStatus(
          request.paidAmount,
          request.deductedAmount,
        );
        break;
      default:
        request.paymentStatus = computePaymentStatus(
          request.approvedAmount ?? 0,
          request.paidAmount,
        );
        request.completedAt =
          request.paidAmount >= (request.approvedAmount ?? 0) &&
          request.paidAmount > 0
            ? (request.completedAt ?? new Date())
            : null;
    }
  }

  /**
   * Phiếu có NCC nhận tiền: lần chi phải ghi rõ chuyển cho ai (NCC hoặc người
   * đề nghị) và không vượt số còn phải chi của người đó. Phiếu không có NCC
   * thì mọi lần chi là của người đề nghị như trước.
   */
  private async assertRecipientRemaining(
    manager: EntityManager,
    request: FinancialRequest,
    supplierId: number | null,
    amount: number,
  ): Promise<FinancialRequestSupplier | null> {
    const suppliers = await manager
      .getRepository(FinancialRequestSupplier)
      .find({ where: { requestId: request.id } });
    if (supplierId === null && !suppliers.length) return null;
    const supplier =
      supplierId !== null
        ? suppliers.find((s) => s.id === supplierId)
        : undefined;
    if (supplierId !== null && !supplier) {
      throw new BadRequestException('Nhà cung cấp không thuộc chứng từ này');
    }
    const [items, payments] = await Promise.all([
      manager
        .getRepository(FinancialRequestItem)
        .find({ where: { requestId: request.id } }),
      manager
        .getRepository(FinancialPayment)
        .find({ where: { requestId: request.id } }),
    ]);
    const totals = recipientTotals(suppliers, items, payments).find(
      (r) => r.supplierId === supplierId,
    );
    const left = totals?.remaining ?? 0;
    const who = supplier ? `NCC ${supplier.name}` : 'người đề nghị';
    // Không chọn người nhận trên phiếu có NCC: thường do màn cũ chưa có ô
    // "Chuyển cho" — chỉ rõ cách chọn thay vì chỉ báo hết tiền.
    const hint = supplier
      ? ''
      : ' — phiếu này chuyển tiền cho nhà cung cấp: chọn NCC ở ô "Chuyển cho" (tải lại trang nếu chưa thấy ô này)';
    if (left <= 0) {
      throw new BadRequestException(
        `Không còn khoản nào phải chi cho ${who}${hint}`,
      );
    }
    if (amount > left) {
      throw new BadRequestException(
        `Số tiền chi ${formatVnd(amount)} đ vượt số còn phải chi cho ${who} (${formatVnd(left)} đ)${hint}`,
      );
    }
    return supplier ?? null;
  }

  async recordPayment(id: number, dto: MoneyMovementDto, user: AuthUser) {
    const ctx = await this.access.context(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, id);
      const existing = await manager
        .getRepository(FinancialPayment)
        .findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        if (existing.requestId !== id) {
          throw new ConflictException(
            'Khoá chống trùng đã dùng cho chứng từ khác',
          );
        }
        return { payment: existing, request, replay: true };
      }
      if (!this.access.canRecordMoney(ctx, request)) {
        throw new ForbiddenException(
          'Bạn không có quyền ghi nhận chi tiền cho chứng từ này',
        );
      }
      if (request.approvalStatus !== ApprovalStatus.APPROVED) {
        throw new BadRequestException(
          'Chỉ ghi nhận chi tiền cho chứng từ đã duyệt',
        );
      }
      const remaining = payableDue(request) - request.paidAmount;
      if (remaining <= 0) {
        throw new BadRequestException('Chứng từ không còn khoản nào phải chi');
      }
      if (dto.amount > remaining) {
        throw new BadRequestException(
          `Số tiền chi ${formatVnd(dto.amount)} đ vượt số còn phải chi ${formatVnd(remaining)} đ`,
        );
      }
      const supplier = await this.assertRecipientRemaining(
        manager,
        request,
        dto.supplierId ?? null,
        dto.amount,
      );
      // Thủ quỹ chọn tài khoản thanh toán ở bước chi tiền (bước cuối).
      const cashAccountCode = await this.assertCashAccount(
        manager,
        requireText(dto.cashAccountCode, 'Chọn tài khoản thanh toán'),
        dto.method,
      );
      // Điều chuyển nội bộ: tiền đi ra đúng nguồn chuyển ghi trên phiếu.
      if (
        request.type === FinancialRequestType.INTERNAL_TRANSFER &&
        cashAccountCode !== request.transferFromAccountCode
      ) {
        throw new BadRequestException(
          `Điều chuyển phải chi từ nguồn chuyển ${request.transferFromAccountCode ?? ''} của phiếu`,
        );
      }
      const payment = await manager.getRepository(FinancialPayment).save(
        manager.getRepository(FinancialPayment).create({
          requestId: id,
          amount: dto.amount,
          supplierId: supplier?.id ?? null,
          paidAt: dto.date,
          method: dto.method,
          cashAccountCode,
          transactionRef: dto.transactionRef || null,
          note: dto.note || null,
          idempotencyKey: dto.idempotencyKey,
          status: MovementStatus.RECORDED,
          recordedById: ctx.userId,
          recordedByName: ctx.name,
        }),
      );
      const before = request.paymentStatus;
      request.paidAmount += dto.amount;
      request.paymentAccountCode = cashAccountCode;
      await this.afterPaidChanged(manager, request);
      await manager.getRepository(FinancialRequest).save(request);
      if (request.type === FinancialRequestType.SALARY_ADVANCE) {
        await this.rebuildDeductionPlan(manager, request, ctx);
      }
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.PAYMENT_RECORDED,
        fromStatus: before,
        toStatus: request.paymentStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: {
          paymentId: payment.id,
          amount: dto.amount,
          date: dto.date,
          method: dto.method,
          cashAccountCode: payment.cashAccountCode,
          transactionRef: payment.transactionRef,
          ...(supplier
            ? { supplierId: supplier.id, supplierName: supplier.name }
            : {}),
        },
      });
      return { payment, request, replay: false, supplier };
    });
    if (!result.replay) {
      await this.notifier.notify(
        [result.request.requesterId],
        result.request,
        'PAID',
        result.request.type === FinancialRequestType.INTERNAL_TRANSFER
          ? `${result.request.code}: đã điều chuyển ${formatVnd(dto.amount)} đ từ ${result.request.transferFromAccountCode} sang ${result.request.transferToAccountCode}.`
          : result.supplier
            ? `${result.request.code}: đã chuyển ${formatVnd(dto.amount)} đ cho NCC ${result.supplier.name}.`
            : `${result.request.code}: đã chi ${formatVnd(dto.amount)} đ cho bạn.`,
        ctx.userId,
      );
    }
    return result.payment;
  }

  async voidPayment(
    id: number,
    paymentId: number,
    dto: ReasonDto,
    user: AuthUser,
  ) {
    dto.reason = requireText(dto.reason, 'Vui lòng nhập lý do huỷ');
    const ctx = await this.access.context(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, id);
      if (!this.access.canVoidMoney(ctx, request)) {
        throw new ForbiddenException('Bạn không có quyền huỷ phiếu chi');
      }
      const payment = await manager.getRepository(FinancialPayment).findOne({
        where: { id: paymentId, requestId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Không tìm thấy phiếu chi');
      if (payment.status === MovementStatus.VOIDED) return payment;

      const newPaid = request.paidAmount - payment.amount;
      if (request.type === FinancialRequestType.ADVANCE) {
        const reserved = await this.reservedByOthers(manager, [request.id]);
        if ((reserved.get(request.id) ?? 0) > newPaid) {
          throw new BadRequestException(
            'Tạm ứng đã được phiếu hoàn ứng đối trừ — huỷ/điều chỉnh hoàn ứng trước',
          );
        }
      }
      if (
        request.type === FinancialRequestType.SALARY_ADVANCE &&
        request.deductedAmount > newPaid
      ) {
        throw new BadRequestException(
          'Khoản ứng lương đã khấu trừ vượt số còn lại sau khi huỷ',
        );
      }

      payment.status = MovementStatus.VOIDED;
      payment.voidedAt = new Date();
      payment.voidedById = ctx.userId;
      payment.voidedByName = ctx.name;
      payment.voidReason = dto.reason;
      await manager.getRepository(FinancialPayment).save(payment);

      const before = request.paymentStatus;
      request.paidAmount = newPaid;
      await this.afterPaidChanged(manager, request);
      await manager.getRepository(FinancialRequest).save(request);
      if (request.type === FinancialRequestType.SALARY_ADVANCE) {
        await this.rebuildDeductionPlan(manager, request, ctx);
      }
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.PAYMENT_VOIDED,
        fromStatus: before,
        toStatus: request.paymentStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.reason,
        changes: { paymentId, amount: payment.amount },
      });
      return payment;
    });
  }

  async recordRefund(id: number, dto: MoneyMovementDto, user: AuthUser) {
    const ctx = await this.access.context(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, id);
      const existing = await manager
        .getRepository(FinancialRefund)
        .findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        if (existing.requestId !== id) {
          throw new ConflictException(
            'Khoá chống trùng đã dùng cho chứng từ khác',
          );
        }
        return { refund: existing, request, replay: true };
      }
      if (!this.access.canRecordMoney(ctx, request)) {
        throw new ForbiddenException(
          'Bạn không có quyền ghi nhận thu tiền cho chứng từ này',
        );
      }
      const remaining = receivableDue(request) - request.recoveredAmount;
      if (remaining <= 0) {
        throw new BadRequestException(
          'Chứng từ không có khoản nào phải thu hồi',
        );
      }
      if (dto.amount > remaining) {
        throw new BadRequestException(
          `Số tiền thu ${formatVnd(dto.amount)} đ vượt số còn phải thu ${formatVnd(remaining)} đ`,
        );
      }
      const refund = await manager.getRepository(FinancialRefund).save(
        manager.getRepository(FinancialRefund).create({
          requestId: id,
          amount: dto.amount,
          receivedAt: dto.date,
          method: dto.method,
          cashAccountCode: await this.assertCashAccount(
            manager,
            dto.cashAccountCode,
            dto.method,
          ),
          transactionRef: dto.transactionRef || null,
          note: dto.note || null,
          idempotencyKey: dto.idempotencyKey,
          status: MovementStatus.RECORDED,
          recordedById: ctx.userId,
          recordedByName: ctx.name,
        }),
      );
      const before = request.settlementStatus;
      request.recoveredAmount += dto.amount;
      this.refreshSettlementStatus(request);
      await manager.getRepository(FinancialRequest).save(request);
      await this.refreshLinkedAdvances(manager, request.id);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.REFUND_RECORDED,
        fromStatus: before,
        toStatus: request.settlementStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        changes: { refundId: refund.id, amount: dto.amount, date: dto.date },
      });
      if (
        before !== SettlementStatus.COMPLETED &&
        request.settlementStatus === SettlementStatus.COMPLETED
      ) {
        await writeAudit(manager, {
          requestId: id,
          action: AuditAction.SETTLEMENT_COMPLETED,
          actorId: ctx.userId,
          actorName: ctx.name,
        });
      }
      return { refund, request, replay: false };
    });
    if (!result.replay) {
      await this.notifier.notify(
        [result.request.requesterId],
        result.request,
        'REFUND_RECORDED',
        `${result.request.code}: đã ghi nhận bạn hoàn trả ${formatVnd(dto.amount)} đ.`,
        ctx.userId,
      );
    }
    return result.refund;
  }

  async voidRefund(
    id: number,
    refundId: number,
    dto: ReasonDto,
    user: AuthUser,
  ) {
    dto.reason = requireText(dto.reason, 'Vui lòng nhập lý do huỷ');
    const ctx = await this.access.context(user);
    return this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, id);
      if (!this.access.canVoidMoney(ctx, request)) {
        throw new ForbiddenException('Bạn không có quyền huỷ phiếu thu');
      }
      const refund = await manager.getRepository(FinancialRefund).findOne({
        where: { id: refundId, requestId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!refund) throw new NotFoundException('Không tìm thấy phiếu thu');
      if (refund.status === MovementStatus.VOIDED) return refund;
      refund.status = MovementStatus.VOIDED;
      refund.voidedAt = new Date();
      refund.voidedById = ctx.userId;
      refund.voidedByName = ctx.name;
      refund.voidReason = dto.reason;
      await manager.getRepository(FinancialRefund).save(refund);
      const before = request.settlementStatus;
      request.recoveredAmount = Math.max(
        request.recoveredAmount - refund.amount,
        0,
      );
      this.refreshSettlementStatus(request);
      await manager.getRepository(FinancialRequest).save(request);
      await this.refreshLinkedAdvances(manager, request.id);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.REFUND_VOIDED,
        fromStatus: before,
        toStatus: request.settlementStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.reason,
        changes: { refundId, amount: refund.amount },
      });
      return refund;
    });
  }

  // ---------------------------------------------------------------------------
  // Khấu trừ tạm ứng lương
  // ---------------------------------------------------------------------------

  /**
   * Lập lại kế hoạch khấu trừ theo số đã thực chi: giữ nguyên kỳ đã trừ, chia
   * phần còn lại đều cho các kỳ chưa trừ. Chưa chi đồng nào thì không có kế hoạch.
   */
  async rebuildDeductionPlan(
    manager: EntityManager,
    request: FinancialRequest,
    actor: Pick<FinanceContext, 'userId' | 'name'>,
  ) {
    const repo = manager.getRepository(FinancialSalaryAdvanceDeduction);
    const rows = await repo.find({ where: { requestId: request.id } });
    const deducted = rows.filter(
      (r) => r.status === DeductionRowStatus.DEDUCTED,
    );
    const planned = rows.filter((r) => r.status === DeductionRowStatus.PLANNED);
    if (planned.length) await repo.delete(planned.map((r) => r.id));

    const outstanding = request.paidAmount - request.deductedAmount;
    if (outstanding <= 0) return [];

    let year =
      request.deductionStartYear ??
      request.salaryYear ??
      new Date().getFullYear();
    let month =
      request.deductionStartMonth ??
      request.salaryMonth ??
      new Date().getMonth() + 1;
    const total = Math.max(request.deductionPeriods ?? 1, 1);
    const taken = new Set(
      rows
        .filter((r) => r.status !== DeductionRowStatus.PLANNED)
        .map((r) => periodKey(r.periodYear, r.periodMonth)),
    );
    const lastDeducted = Math.max(
      0,
      ...deducted.map((r) => periodKey(r.periodYear, r.periodMonth)),
    );

    const periods: { year: number; month: number }[] = [];
    for (let i = 0; i < total; i += 1) {
      const key = periodKey(year, month);
      if (!taken.has(key) && key > lastDeducted) periods.push({ year, month });
      ({ year, month } = nextPeriod(year, month));
    }
    while (!periods.length) {
      const key = periodKey(year, month);
      if (!taken.has(key) && key > lastDeducted) periods.push({ year, month });
      ({ year, month } = nextPeriod(year, month));
    }

    const amounts = splitEvenly(outstanding, periods.length);
    const created = await repo.save(
      periods.map((period, index) =>
        repo.create({
          requestId: request.id,
          employeeId: request.requesterId,
          periodYear: period.year,
          periodMonth: period.month,
          plannedAmount: amounts[index],
          status: DeductionRowStatus.PLANNED,
        }),
      ),
    );
    await writeAudit(manager, {
      requestId: request.id,
      action: AuditAction.DEDUCTION_PLANNED,
      actorId: actor.userId,
      actorName: actor.name,
      changes: {
        periods: created.map((row) => ({
          period: `${String(row.periodMonth).padStart(2, '0')}/${row.periodYear}`,
          amount: row.plannedAmount,
        })),
      },
    });
    return created;
  }

  async confirmDeduction(
    id: number,
    deductionId: number,
    dto: ConfirmDeductionDto,
    user: AuthUser,
  ) {
    const ctx = await this.access.context(user);
    const result = await this.dataSource.transaction(async (manager) => {
      const request = await this.lockRequest(manager, id);
      if (request.type !== FinancialRequestType.SALARY_ADVANCE) {
        throw new BadRequestException('Chỉ áp dụng cho tạm ứng lương');
      }
      if (!this.access.canConfirmDeduction(ctx, request)) {
        throw new ForbiddenException(
          'Bạn không có quyền ghi nhận khấu trừ lương',
        );
      }
      const repo = manager.getRepository(FinancialSalaryAdvanceDeduction);
      const replay = await repo.findOne({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (replay) {
        if (replay.id !== deductionId) {
          throw new ConflictException(
            'Khoá chống trùng đã dùng cho kỳ khấu trừ khác',
          );
        }
        return { row: replay, request, replay: true };
      }
      const row = await repo.findOne({
        where: { id: deductionId, requestId: id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('Không tìm thấy kỳ khấu trừ');
      if (row.status !== DeductionRowStatus.PLANNED) {
        throw new ConflictException('Kỳ này đã được ghi nhận khấu trừ');
      }
      const outstanding = request.paidAmount - request.deductedAmount;
      const amount = dto.amount ?? row.plannedAmount;
      if (amount <= 0 || amount > outstanding) {
        throw new BadRequestException(
          `Số khấu trừ phải trong khoảng 1 – ${formatVnd(outstanding)} đ`,
        );
      }
      const payroll = await manager.getRepository(Payroll).findOne({
        where: {
          employeeId: request.requesterId,
          year: row.periodYear,
          month: row.periodMonth,
        },
      });
      row.status = DeductionRowStatus.DEDUCTED;
      row.deductedAmount = amount;
      row.payrollId = payroll?.id ?? null;
      row.idempotencyKey = dto.idempotencyKey;
      row.deductedAt = new Date();
      row.deductedById = ctx.userId;
      row.deductedByName = ctx.name;
      row.note = dto.note || null;
      await repo.save(row);

      const before = request.deductionStatus;
      request.deductedAmount += amount;
      request.deductionStatus = computeDeductionStatus(
        request.paidAmount,
        request.deductedAmount,
      );
      request.completedAt =
        request.deductionStatus === 'DEDUCTED'
          ? (request.completedAt ?? new Date())
          : null;
      await manager.getRepository(FinancialRequest).save(request);
      await writeAudit(manager, {
        requestId: id,
        action: AuditAction.DEDUCTION_CONFIRMED,
        fromStatus: before,
        toStatus: request.deductionStatus,
        actorId: ctx.userId,
        actorName: ctx.name,
        comment: dto.note ?? null,
        changes: {
          deductionId,
          period: `${String(row.periodMonth).padStart(2, '0')}/${row.periodYear}`,
          amount,
          payrollId: row.payrollId,
        },
      });
      // Phần chưa trừ (nếu trừ ít hơn kế hoạch) dồn sang các kỳ sau.
      if (amount !== row.plannedAmount) {
        await this.rebuildDeductionPlan(manager, request, ctx);
      }
      return { row, request, replay: false };
    });
    if (!result.replay) {
      await this.notifier.notify(
        [result.request.requesterId],
        result.request,
        'SALARY_DEDUCTED',
        `${result.request.code}: đã khấu trừ ${formatVnd(result.row.deductedAmount ?? 0)} đ vào lương tháng ${result.row.periodMonth}/${result.row.periodYear}.`,
        ctx.userId,
      );
    }
    return result.row;
  }

  /** Danh sách kỳ khấu trừ (cho màn quản lý lương / kế toán). */
  async listDeductions(user: AuthUser, query: DeductionQueryDto) {
    const ctx = await this.access.context(user);
    const qb = this.deductionRepo
      .createQueryBuilder('d')
      .innerJoinAndMapOne(
        'd.request',
        FinancialRequest,
        'r',
        'r.id = d.request_id',
      )
      .orderBy('d.periodYear', 'DESC')
      .addOrderBy('d.periodMonth', 'DESC')
      .addOrderBy('r.requesterName', 'ASC')
      .take(500);
    this.access.applyVisibility(qb, ctx, 'r');
    if (query.companyId)
      qb.andWhere('r.company_id = :companyId', { companyId: query.companyId });
    if (query.employeeId)
      qb.andWhere('d.employee_id = :employeeId', {
        employeeId: query.employeeId,
      });
    if (query.year) qb.andWhere('d.period_year = :year', { year: query.year });
    if (query.month)
      qb.andWhere('d.period_month = :month', { month: query.month });
    if (query.status)
      qb.andWhere('d.status = :status', { status: query.status });
    const rows = await qb.getMany();
    return rows.map((row) => {
      const request = (row as any).request as FinancialRequest;
      return {
        id: row.id,
        requestId: row.requestId,
        requestCode: request.code,
        companyId: request.companyId,
        employeeId: row.employeeId,
        employeeName: request.requesterName,
        departmentName: request.departmentName,
        periodYear: row.periodYear,
        periodMonth: row.periodMonth,
        plannedAmount: row.plannedAmount,
        deductedAmount: row.deductedAmount,
        status: row.status,
        payrollId: row.payrollId,
        deductedAt: row.deductedAt,
        deductedByName: row.deductedByName,
        canConfirm:
          row.status === DeductionRowStatus.PLANNED &&
          this.access.canConfirmDeduction(ctx, request),
      };
    });
  }

  /**
   * Số tạm ứng lương phải trừ trong một kỳ lương của một nhân viên — để người
   * lập phiếu lương đối chiếu cột "Tạm ứng". Không tự sửa phiếu lương.
   */
  async payrollPreview(
    user: AuthUser,
    employeeId: number,
    year: number,
    month: number,
  ) {
    const ctx = await this.access.context(user);
    const allowed =
      ctx.userId === employeeId ||
      ctx.isAdmin ||
      this.access.hasAnyRole(ctx, [FinanceRole.ACCOUNTANT]) ||
      ctx.systemRoles.some((role) =>
        ['nhansu', 'ketoan_truong'].includes(role),
      );
    if (!allowed)
      throw new ForbiddenException('Bạn không có quyền xem dữ liệu này');
    const rows = await this.deductionRepo
      .createQueryBuilder('d')
      .innerJoinAndMapOne(
        'd.request',
        FinancialRequest,
        'r',
        'r.id = d.request_id',
      )
      .where('d.employee_id = :employeeId', { employeeId })
      .andWhere('d.period_year = :year AND d.period_month = :month', {
        year,
        month,
      })
      .andWhere('d.status <> :cancelled', {
        cancelled: DeductionRowStatus.CANCELLED,
      })
      .andWhere('r.deleted_at IS NULL')
      .getMany();
    return {
      employeeId,
      year,
      month,
      plannedAmount: sumMoney(
        rows
          .filter((r) => r.status === DeductionRowStatus.PLANNED)
          .map((r) => r.plannedAmount),
      ),
      deductedAmount: sumMoney(
        rows
          .filter((r) => r.status === DeductionRowStatus.DEDUCTED)
          .map((r) => r.deductedAmount),
      ),
      rows: rows.map((row) => ({
        id: row.id,
        requestId: row.requestId,
        requestCode: ((row as any).request as FinancialRequest).code,
        plannedAmount: row.plannedAmount,
        deductedAmount: row.deductedAmount,
        status: row.status,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Công nợ
  // ---------------------------------------------------------------------------

  /**
   * Công nợ theo nhân viên, tính từ phiếu đã duyệt. Tách riêng: tạm ứng chưa
   * hoàn, phải thu hồi, phải trả nhân viên, ứng lương chưa khấu trừ.
   */
  async balances(user: AuthUser, query: BalanceQueryDto) {
    const ctx = await this.access.context(user);
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .where('r.approval_status = :approved', {
        approved: ApprovalStatus.APPROVED,
      });
    this.access.applyVisibility(qb, ctx);
    if (query.employeeId)
      qb.andWhere('r.requester_id = :employeeId', {
        employeeId: query.employeeId,
      });
    if (query.companyId)
      qb.andWhere('r.company_id = :companyId', { companyId: query.companyId });
    const requests = await qb.getMany();

    const today = vnToday();
    const byEmployee = new Map<
      number,
      {
        employeeId: number;
        employeeName: string;
        departmentName: string | null;
        advanceOutstanding: number;
        advanceOverdue: number;
        overdueCount: number;
        receivable: number;
        payable: number;
        salaryAdvanceOutstanding: number;
      }
    >();
    for (const r of requests) {
      const row = byEmployee.get(r.requesterId) ?? {
        employeeId: r.requesterId,
        employeeName: r.requesterName,
        departmentName: r.departmentName,
        advanceOutstanding: 0,
        advanceOverdue: 0,
        overdueCount: 0,
        receivable: 0,
        payable: 0,
        salaryAdvanceOutstanding: 0,
      };
      row.payable += Math.max(payableDue(r) - r.paidAmount, 0);
      row.receivable += Math.max(receivableDue(r) - r.recoveredAmount, 0);
      if (r.type === FinancialRequestType.ADVANCE) {
        const outstanding = Math.max(r.paidAmount - r.settledAmount, 0);
        row.advanceOutstanding += outstanding;
        if (
          outstanding > 0 &&
          r.settlementDueDate &&
          r.settlementDueDate < today
        ) {
          row.advanceOverdue += outstanding;
          row.overdueCount += 1;
        }
      }
      if (r.type === FinancialRequestType.SALARY_ADVANCE) {
        row.salaryAdvanceOutstanding += Math.max(
          r.paidAmount - r.deductedAmount,
          0,
        );
      }
      byEmployee.set(r.requesterId, row);
    }
    const rows = [...byEmployee.values()]
      .filter(
        (row) =>
          row.advanceOutstanding ||
          row.receivable ||
          row.payable ||
          row.salaryAdvanceOutstanding,
      )
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'vi'));
    const totals = {
      advanceOutstanding: sumMoney(rows.map((r) => r.advanceOutstanding)),
      advanceOverdue: sumMoney(rows.map((r) => r.advanceOverdue)),
      receivable: sumMoney(rows.map((r) => r.receivable)),
      payable: sumMoney(rows.map((r) => r.payable)),
      salaryAdvanceOutstanding: sumMoney(
        rows.map((r) => r.salaryAdvanceOutstanding),
      ),
    };
    return { rows, totals };
  }

  /** Số tạm ứng chưa quyết toán của chính người đang đăng nhập — cảnh báo khi lập phiếu thanh toán. */
  async myOpenAdvances(userId: number, companyId?: number) {
    const qb = this.requestRepo
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .andWhere('r.type = :type', { type: FinancialRequestType.ADVANCE })
      .andWhere('r.requester_id = :userId', { userId })
      .andWhere('r.approval_status = :approved', {
        approved: ApprovalStatus.APPROVED,
      })
      .andWhere('r.paid_amount > r.settled_amount');
    if (companyId) qb.andWhere('r.company_id = :companyId', { companyId });
    const rows = await qb.getMany();
    return {
      count: rows.length,
      outstanding: sumMoney(rows.map((r) => r.paidAmount - r.settledAmount)),
    };
  }

  /** Dùng khi huỷ phiếu đã duyệt: có phát sinh tiền thì không được huỷ. */
  async hasMoneyMovements(manager: EntityManager, request: FinancialRequest) {
    if (
      request.paidAmount > 0 ||
      request.recoveredAmount > 0 ||
      request.deductedAmount > 0
    ) {
      return true;
    }
    if (request.type === FinancialRequestType.ADVANCE) {
      const reserved = await this.reservedByOthers(manager, [request.id]);
      if ((reserved.get(request.id) ?? 0) > 0) return true;
    }
    return false;
  }

  /** Phiếu tạm ứng đang được những phiếu hoàn ứng nào đối trừ. */
  async settlementsOfAdvance(advanceId: number) {
    const rows = await this.allocationRepo
      .createQueryBuilder('a')
      .innerJoinAndMapOne(
        'a.settlement',
        FinancialRequest,
        's',
        's.id = a.settlement_id',
      )
      .where('a.advance_id = :advanceId', { advanceId })
      .andWhere('s.deleted_at IS NULL')
      .orderBy('a.created_at', 'ASC')
      .getMany();
    return rows.map((row) => {
      const settlement = (row as any).settlement as FinancialRequest;
      return {
        settlementId: settlement.id,
        code: settlement.code,
        requestDate: settlement.requestDate,
        approvalStatus: settlement.approvalStatus,
        settlementStatus: settlement.settlementStatus,
        amount: row.amount,
        appliedAt: row.appliedAt,
      };
    });
  }

  /** Dùng cho chi tiết phiếu hoàn ứng. */
  async allocationsOfSettlement(settlement: FinancialRequest) {
    const rows = await this.allocationRepo
      .createQueryBuilder('a')
      .innerJoinAndMapOne(
        'a.advance',
        FinancialRequest,
        'adv',
        'adv.id = a.advance_id',
      )
      .where('a.settlement_id = :id', { id: settlement.id })
      .orderBy('adv.request_date', 'ASC')
      .getMany();
    const reserved = await this.reservedByOthers(
      this.dataSource.manager,
      rows.map((r) => r.advanceId),
      settlement.id,
    );
    return rows.map((row) => {
      const advance = (row as any).advance as FinancialRequest;
      const others = reserved.get(advance.id) ?? 0;
      return {
        advanceId: advance.id,
        code: advance.code,
        title: advance.title,
        requestDate: advance.requestDate,
        paidAmount: advance.paidAmount,
        allocatedElsewhere: others,
        available: advanceAvailable(advance.paidAmount, others),
        amount: row.amount,
        appliedAt: row.appliedAt,
        advanceSettlementStatus: advance.settlementStatus,
      };
    });
  }

  recoveryOpen(request: FinancialRequest) {
    return [RecoveryStatus.PENDING, RecoveryStatus.PARTIAL].includes(
      request.recoveryStatus,
    );
  }
}
