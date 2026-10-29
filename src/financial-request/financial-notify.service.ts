import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';

import { NotificationType } from '../notifications/enums/notification-type.enum';
import { NotificationService } from '../notifications/services/notification.service';
import { isCronLeader } from '../utils/is-cron-leader';
import { FinancialAuditLog } from './entities/financial-audit-log.entity';
import { FinancialPolicy } from './entities/financial-policy.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { daysUntil, vnToday } from './financial-calculations';
import { FinancialAccessService } from './financial-access.service';
import {
  ApprovalStatus,
  FINANCE_NOTIFICATION_ROUTE,
  FinanceRole,
  FinancialRequestType,
  RecoveryStatus,
  REQUEST_TYPE_LABELS,
  SettlementStatus,
} from './financial-request.constants';
import { formatVnd } from './financial-money';

export type FinanceNotificationKind =
  | 'APPROVAL_REQUIRED'
  | 'NEXT_LEVEL'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'REFUND_RECORDED'
  | 'ADVANCE_DUE_SOON'
  | 'ADVANCE_OVERDUE'
  | 'REFUND_OUTSTANDING'
  | 'SALARY_DEDUCTED'
  | 'CANCELLED';

export interface AuditEntry {
  requestId?: number | null;
  entityType?: string;
  entityId?: number | null;
  action: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actorId?: number | null;
  actorName?: string | null;
  comment?: string | null;
  changes?: Record<string, unknown> | null;
}

/** Ghi nhật ký trong cùng transaction với thao tác nghiệp vụ. */
export async function writeAudit(manager: EntityManager, entry: AuditEntry) {
  const repo = manager.getRepository(FinancialAuditLog);
  await repo.save(
    repo.create({
      requestId: entry.requestId ?? null,
      entityType: entry.entityType ?? 'REQUEST',
      entityId: entry.entityId ?? entry.requestId ?? null,
      action: entry.action,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      comment: entry.comment ?? null,
      changes: entry.changes ?? null,
    }),
  );
}

/**
 * Thông báo của phân hệ tài chính qua hệ thống thông báo chung (trong app +
 * socket + push). Nội dung chỉ gồm mã phiếu, loại, số tiền — không chứa số
 * tài khoản hay dữ liệu lương. Lỗi gửi không bao giờ làm hỏng nghiệp vụ.
 */
@Injectable()
export class FinancialNotifyService {
  private readonly logger = new Logger(FinancialNotifyService.name);

  constructor(
    private readonly notificationService: NotificationService,
    private readonly access: FinancialAccessService,
    @InjectRepository(FinancialRequest)
    private readonly requestRepo: Repository<FinancialRequest>,
    @InjectRepository(FinancialPolicy)
    private readonly policyRepo: Repository<FinancialPolicy>,
  ) {}

  private describe(request: FinancialRequest) {
    return `${REQUEST_TYPE_LABELS[request.type]} ${request.code}`;
  }

  async notify(
    receiverIds: Array<number | null | undefined>,
    request: FinancialRequest,
    kind: FinanceNotificationKind,
    message: string,
    senderId?: number,
  ) {
    const receivers = [
      ...new Set(receiverIds.filter((id): id is number => !!id)),
    ].filter((id) => id !== senderId);
    for (const receiverId of receivers) {
      try {
        await this.notificationService.create({
          receiverId,
          senderId,
          type: NotificationType.FINANCIAL_REQUEST,
          entityId: request.id,
          message,
          meta: {
            requestId: request.id,
            code: request.code,
            requestType: request.type,
            kind,
            route: `${FINANCE_NOTIFICATION_ROUTE}/${request.id}`,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Không gửi được thông báo ${kind} cho #${receiverId}: ${(error as Error).message}`,
        );
      }
    }
  }

  approvalRequired(
    receiverIds: number[],
    request: FinancialRequest,
    stepName: string,
    senderId?: number,
  ) {
    return this.notify(
      receiverIds,
      request,
      'APPROVAL_REQUIRED',
      `${this.describe(request)} của ${request.requesterName} (${formatVnd(request.totalAmount)} đ) đang chờ bạn duyệt — cấp "${stepName}".`,
      senderId,
    );
  }

  nextLevel(request: FinancialRequest, stepName: string, senderId?: number) {
    return this.notify(
      [request.requesterId],
      request,
      'NEXT_LEVEL',
      `${this.describe(request)} đã được duyệt một cấp, chuyển tới cấp "${stepName}".`,
      senderId,
    );
  }

  async approved(request: FinancialRequest, senderId?: number) {
    await this.notify(
      [request.requesterId],
      request,
      'APPROVED',
      `${this.describe(request)} đã được phê duyệt (${formatVnd(request.approvedAmount ?? request.totalAmount)} đ).`,
      senderId,
    );
  }

  /** Báo người ghi nhận chi tiền (kế toán + thủ quỹ trong phạm vi). */
  async paymentPending(
    request: FinancialRequest,
    amount: number,
    senderId?: number,
  ) {
    if (amount <= 0) return;
    const [accountants, cashiers] = await Promise.all([
      this.access.employeesWithRole(
        FinanceRole.ACCOUNTANT,
        request.companyId,
        request.departmentId,
      ),
      this.access.employeesWithRole(
        FinanceRole.CASHIER,
        request.companyId,
        request.departmentId,
      ),
    ]);
    await this.notify(
      [...accountants, ...cashiers].filter((id) => id !== request.requesterId),
      request,
      'PAYMENT_PENDING',
      `${this.describe(request)} của ${request.requesterName} đã duyệt, chờ chi ${formatVnd(amount)} đ.`,
      senderId,
    );
  }

  /**
   * 08:00 hằng ngày: tạm ứng sắp tới/quá hạn hoàn ứng và khoản hoàn trả còn
   * thiếu. Chỉ chạy trên instance production (như các cron khác).
   */
  @Cron('0 8 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async dailyReminders() {
    if (!isCronLeader()) return;
    try {
      await this.sendReminders();
    } catch (error) {
      this.logger.error(`Nhắc hạn tài chính lỗi: ${(error as Error).message}`);
    }
  }

  async sendReminders(today = vnToday()) {
    const global = await this.policyRepo.findOne({
      where: { scopeKey: 'GLOBAL' },
    });
    const defaultReminder = global?.reminderDaysBefore ?? 3;

    const advances = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.deleted_at IS NULL')
      .andWhere('r.type = :type', { type: FinancialRequestType.ADVANCE })
      .andWhere('r.approval_status = :approved', {
        approved: ApprovalStatus.APPROVED,
      })
      .andWhere('r.paid_amount > r.settled_amount')
      .andWhere('r.settlement_due_date IS NOT NULL')
      .getMany();

    const policies = await this.policyRepo.find();
    const reminderFor = (companyId: number) =>
      policies.find((p) => p.scopeKey === `COMPANY:${companyId}`)
        ?.reminderDaysBefore ?? defaultReminder;

    for (const request of advances) {
      const days = daysUntil(request.settlementDueDate as string, today);
      const outstanding = request.paidAmount - request.settledAmount;
      const reminder = reminderFor(request.companyId);
      if (days >= 0 && (days === reminder || days === 1)) {
        await this.notify(
          [request.requesterId],
          request,
          'ADVANCE_DUE_SOON',
          `${this.describe(request)} còn ${formatVnd(outstanding)} đ chưa hoàn ứng, hạn ${request.settlementDueDate} (còn ${days} ngày).`,
        );
      } else if (days < 0 && (-days === 1 || -days % 7 === 0)) {
        const accountants = await this.access.employeesWithRole(
          FinanceRole.ACCOUNTANT,
          request.companyId,
          request.departmentId,
        );
        await this.notify(
          [request.requesterId, ...accountants],
          request,
          'ADVANCE_OVERDUE',
          `${this.describe(request)} của ${request.requesterName} đã quá hạn hoàn ứng ${-days} ngày, còn ${formatVnd(outstanding)} đ.`,
        );
      }
    }

    // Thứ Hai hằng tuần: nhắc khoản phải hoàn trả còn thiếu.
    if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return;
    const settlements = await this.requestRepo.find({
      where: {
        type: FinancialRequestType.SETTLEMENT,
        approvalStatus: ApprovalStatus.APPROVED,
        settlementStatus: SettlementStatus.PENDING_REFUND,
        recoveryStatus: In([RecoveryStatus.PENDING, RecoveryStatus.PARTIAL]),
      },
    });
    for (const request of settlements) {
      if (request.deletedAt) continue;
      const due = Math.max(
        request.offsetAmount - (request.approvedAmount ?? 0),
        0,
      );
      const remaining = due - request.recoveredAmount;
      if (remaining <= 0) continue;
      await this.notify(
        [request.requesterId],
        request,
        'REFUND_OUTSTANDING',
        `${this.describe(request)}: còn ${formatVnd(remaining)} đ tạm ứng thừa cần hoàn trả cho công ty.`,
      );
    }
  }
}
