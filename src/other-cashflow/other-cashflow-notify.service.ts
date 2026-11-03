import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import { FcmService } from '../fcm/fcm.service';
import { formatVnd } from '../financial-request/financial-money';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { NotificationService } from '../notifications/services/notification.service';
import { OtherCashflowContract } from './entities/other-cashflow-contract.entity';
import { OtherCashflowEntry } from './entities/other-cashflow-entry.entity';
import { OtherCashflowOrder } from './entities/other-cashflow-order.entity';
import {
  CashflowDirection,
  contractCode,
  NOTIFICATION_KIND,
  OrderKind,
  OTHER_CASHFLOW_APPROVE_ROLES,
  OTHER_CASHFLOW_DEBT_ROLES,
  OTHER_CASHFLOW_RECORD_ROLES,
  OtherCashflowForm,
  OtherCashflowStatus,
} from './other-cashflow.constants';

export type OtherCashflowNotificationAction =
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'REJECTED'
  | 'RECORD_REQUIRED'
  | 'RECORDED'
  | 'DEBT_REQUIRED'
  | 'ORDER_CREATED'
  | 'ORDER_EXECUTED'
  | 'CANCELLED';

/**
 * Thông báo dùng loại POLICY để hiện trong nhóm "Chính sách" của chuông
 * thông báo, nhưng KHÔNG đặt `entityId` (tránh trùng id với chính sách thật
 * khi đánh dấu đã đọc theo type+entity) — FE mở hợp đồng theo
 * `meta.kind` + `meta.contractId`. Lỗi gửi không làm hỏng nghiệp vụ.
 */
@Injectable()
export class OtherCashflowNotifyService {
  private readonly logger = new Logger(OtherCashflowNotifyService.name);

  constructor(
    private readonly notifications: NotificationService,
    private readonly fcm: FcmService,
    private readonly fcmTokens: EmployeeFcmTokenService,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
    @InjectRepository(Notification)
    private readonly notificationRepo: Repository<Notification>,
  ) {}

  describe(contract: OtherCashflowContract) {
    const kind =
      contract.form === OtherCashflowForm.COMMERCIAL
        ? 'Đơn thương mại'
        : 'HĐ thu chi ngoài';
    const money = [
      contract.amount > 0 ? `thu ${formatVnd(contract.amount)} đ` : null,
      contract.costAmount > 0 ? `chi ${formatVnd(contract.costAmount)} đ` : null,
    ].filter(Boolean);
    return `${kind} ${contractCode(contract.id)} "${contract.title}" (${money.join(' · ')})`;
  }

  /** "thu, chi" / "thu" / "chi" — việc còn phải làm của hợp đồng. */
  private flows(contract: OtherCashflowContract) {
    return [
      contract.amount > 0 ? 'thu' : null,
      contract.costAmount > 0 ? 'chi' : null,
    ]
      .filter(Boolean)
      .join(', ');
  }

  async idsWithRoles(roles: string[]): Promise<number[]> {
    const rows = await this.employeeRepo
      .createQueryBuilder('e')
      .select('e.id', 'id')
      .where('e.roles && ARRAY[:...roles]::text[]', { roles })
      .getRawMany<{ id: number }>();
    return rows.map((row) => Number(row.id));
  }

  async send(
    receiverIds: number[],
    contract: OtherCashflowContract,
    action: OtherCashflowNotificationAction,
    message: string,
    senderId?: number,
  ) {
    const receivers = [...new Set(receiverIds)].filter(
      (id) => !!id && id !== senderId,
    );
    if (!receivers.length) return;
    try {
      await this.notifications.createNotifications({
        receiverIds: receivers,
        type: NotificationType.POLICY,
        message,
        senderId,
        meta: {
          kind: NOTIFICATION_KIND,
          action,
          contractId: contract.id,
          code: contractCode(contract.id),
          status: contract.status,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Không tạo được thông báo ${action} (${contractCode(contract.id)}): ${(error as Error).message}`,
      );
    }
    try {
      const tokens = (await this.fcmTokens.getTokens(receivers)).map(
        (row) => row.token,
      );
      if (tokens.length) {
        await this.fcm.sendToMultiple(tokens, 'Thu Chi ngoài', message, {
          type: NOTIFICATION_KIND,
          id: String(contract.id),
        });
      }
    } catch (error) {
      this.logger.warn(
        `Không gửi được push ${action} (${contractCode(contract.id)}): ${(error as Error).message}`,
      );
    }
  }

  async reviewRequired(contract: OtherCashflowContract, resubmitted: boolean) {
    const directors = await this.idsWithRoles(OTHER_CASHFLOW_APPROVE_ROLES);
    await this.send(
      directors,
      contract,
      'REVIEW_REQUIRED',
      `${contract.createdByName ?? 'NV kinh doanh'} ${resubmitted ? 'đã sửa và gửi lại' : 'gửi duyệt'} ${this.describe(contract)}.`,
      contract.createdById,
    );
  }

  async reviewed(contract: OtherCashflowContract, actor: { id: number; name: string | null }) {
    const approved = contract.status !== OtherCashflowStatus.REJECTED;
    await this.send(
      [contract.createdById],
      contract,
      approved ? 'APPROVED' : 'REJECTED',
      `${actor.name ?? 'Giám đốc'} đã ${approved ? 'duyệt' : 'từ chối'} ${this.describe(contract)}${!approved && contract.reviewNote ? `: ${contract.reviewNote}` : '.'}`,
      actor.id,
    );
    if (!approved) return;
    // Hình thức Thương mại đi luồng công nợ: kế toán công nợ lập phiếu trước.
    if (contract.form === OtherCashflowForm.COMMERCIAL) {
      const orders = [
        contract.amount > 0 ? 'phiếu thu' : null,
        contract.costAmount > 0 ? 'lệnh chi' : null,
      ].filter(Boolean);
      await this.send(
        await this.idsWithRoles(OTHER_CASHFLOW_DEBT_ROLES),
        contract,
        'DEBT_REQUIRED',
        `${this.describe(contract)} đã được duyệt — cần lập ${orders.join(' và ')}.`,
        actor.id,
      );
      return;
    }
    const cashiers = await this.idsWithRoles(OTHER_CASHFLOW_RECORD_ROLES);
    await this.send(
      cashiers,
      contract,
      'RECORD_REQUIRED',
      `${this.describe(contract)} đã được duyệt — cần ${this.flows(contract)}.`,
      actor.id,
    );
  }

  async orderCreated(
    contract: OtherCashflowContract,
    order: OtherCashflowOrder,
    costLabel: string | null,
    actor: { id: number; name: string | null },
  ) {
    const what =
      order.kind === OrderKind.RECEIPT
        ? `phiếu thu ${formatVnd(order.amount)} đ`
        : `lệnh chi ${formatVnd(order.amount)} đ khoản "${costLabel ?? ''}"`;
    await this.send(
      await this.idsWithRoles(OTHER_CASHFLOW_RECORD_ROLES),
      contract,
      'ORDER_CREATED',
      `${actor.name ?? 'Kế toán công nợ'} đã lập ${what} cho ${this.describe(contract)} — chờ thủ quỹ ${order.kind === OrderKind.RECEIPT ? 'thu' : 'chi'}.`,
      actor.id,
    );
  }

  async orderExecuted(
    contract: OtherCashflowContract,
    order: OtherCashflowOrder,
    actor: { id: number; name: string | null },
  ) {
    const receipt = order.kind === OrderKind.RECEIPT;
    await this.send(
      [contract.createdById, order.createdById],
      contract,
      'ORDER_EXECUTED',
      `Thủ quỹ đã ${receipt ? 'thu' : 'chi'} ${formatVnd(order.amount)} đ theo ${receipt ? 'phiếu thu' : 'lệnh chi'} của ${this.describe(contract)} — ${this.progress(contract, receipt)}.`,
      actor.id,
    );
  }

  async recorded(
    contract: OtherCashflowContract,
    entry: Pick<OtherCashflowEntry, 'flow' | 'amount'>,
    costLabel: string | null,
    actor: { id: number; name: string | null },
  ) {
    const receipt = entry.flow === CashflowDirection.IN;
    await this.send(
      [contract.createdById],
      contract,
      'RECORDED',
      `Thủ quỹ đã ${receipt ? 'thu' : `chi khoản "${costLabel ?? ''}"`} ${formatVnd(entry.amount)} đ cho ${this.describe(contract)} — ${this.progress(contract, receipt)}.`,
      actor.id,
    );
  }

  private progress(contract: OtherCashflowContract, receipt: boolean) {
    return receipt
      ? `đã thu ${formatVnd(contract.recordedAmount)}/${formatVnd(contract.amount)} đ`
      : `đã chi ${formatVnd(contract.paidCostAmount)}/${formatVnd(contract.costAmount)} đ`;
  }

  async cancelled(contract: OtherCashflowContract, actor: { id: number; name: string | null }) {
    if (actor.id === contract.createdById) return;
    await this.send(
      [contract.createdById],
      contract,
      'CANCELLED',
      `${actor.name ?? 'Giám đốc'} đã huỷ ${this.describe(contract)}${contract.cancelReason ? `: ${contract.cancelReason}` : '.'}`,
      actor.id,
    );
  }

  /**
   * Đã chốt duyệt/từ chối/huỷ — thông báo "cần duyệt" cũ hết ý nghĩa với mọi
   * giám đốc nhận được nó, không chỉ người vừa thao tác.
   */
  async closeReviewRequests(contractId: number) {
    try {
      await this.notificationRepo
        .createQueryBuilder()
        .update(Notification)
        .set({ isRead: true })
        .where('type = :type', { type: NotificationType.POLICY })
        .andWhere('"entityId" IS NULL')
        .andWhere('"isRead" = false')
        .andWhere(`meta ->> 'kind' = :kind`, { kind: NOTIFICATION_KIND })
        .andWhere(`meta ->> 'action' = 'REVIEW_REQUIRED'`)
        .andWhere(`meta ->> 'contractId' = :contractId`, {
          contractId: String(contractId),
        })
        .execute();
    } catch (error) {
      this.logger.warn(
        `Không đánh dấu đã đọc được thông báo duyệt ${contractCode(contractId)}: ${(error as Error).message}`,
      );
    }
  }
}
