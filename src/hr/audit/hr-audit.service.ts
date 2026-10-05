import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { maskSensitive } from '../common/sensitive-mask';
import { HrAuditLog } from './entities/hr-audit-log.entity';
import {
  HrAuditAction,
  isHrAuditAction,
  READ_ONLY_ACTIONS,
  REASON_REQUIRED_ACTIONS,
} from './hr-audit-action';
import { HrAuditActor } from './hr-audit-actor';

export interface HrAuditEntry {
  actor: HrAuditActor;
  action: HrAuditAction;
  /** Loại đối tượng, dạng snake_case: `account_permission_grant`, `employee`... */
  entity: string;
  entityId?: string | number | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}

const ENTITY_NAME = /^[a-z][a-z0-9_.]{0,63}$/;
const MAX_REASON = 2000;
/** Giới hạn mỗi cột jsonb — audit không phải nơi chứa file. */
const MAX_VALUE_BYTES = 32 * 1024;

export class HrAuditValidationError extends Error {}

function prepareValue(value: unknown): unknown {
  if (value === undefined) return null;
  const masked = maskSensitive(value);
  const json = JSON.stringify(masked);
  if (json !== undefined && Buffer.byteLength(json) > MAX_VALUE_BYTES) {
    return { _truncated: true, bytes: Buffer.byteLength(json) };
  }
  return masked;
}

@Injectable()
export class HrAuditService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Ghi audit TRONG transaction của thao tác nghiệp vụ: thao tác rollback thì
   * dòng audit cũng rollback, thao tác commit thì chắc chắn có audit.
   *
   *   await dataSource.transaction(async (manager) => {
   *     ...ghi dữ liệu bằng manager...
   *     await audit.record(manager, { actor, action, entity, ... });
   *   });
   */
  async record(manager: EntityManager, entry: HrAuditEntry): Promise<string> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new HrAuditValidationError(
        'Audit phải ghi trong transaction của thao tác (dataSource.transaction)',
      );
    }
    return this.insert(manager, entry);
  }

  /**
   * Ghi audit cho hành động CHỈ ĐỌC (xem CCCD đầy đủ, tải file) — không có
   * thay đổi dữ liệu nào để chung transaction.
   */
  async recordStandalone(entry: HrAuditEntry): Promise<string> {
    if (!READ_ONLY_ACTIONS.includes(entry.action)) {
      throw new HrAuditValidationError(
        `${entry.action} làm thay đổi dữ liệu — phải dùng record(manager, ...) trong transaction`,
      );
    }
    return this.insert(this.dataSource.manager, entry);
  }

  private async insert(
    manager: EntityManager,
    entry: HrAuditEntry,
  ): Promise<string> {
    // Cột jsonb nhận giá trị bất kỳ đã qua maskSensitive — kiểu `unknown` của
    // entity không khớp kiểu partial sâu của TypeORM, nên ép kiểu tại đây.
    const row = this.toRow(entry) as QueryDeepPartialEntity<HrAuditLog>;
    const result = await manager.insert(HrAuditLog, row);
    return String((result.identifiers[0] as { id: string | number }).id);
  }

  private toRow(entry: HrAuditEntry): Partial<HrAuditLog> {
    if (!isHrAuditAction(entry.action)) {
      throw new HrAuditValidationError(
        `Hành động audit không hợp lệ: ${String(entry.action)}`,
      );
    }
    if (!ENTITY_NAME.test(entry.entity)) {
      throw new HrAuditValidationError(
        `Tên entity audit không hợp lệ: ${entry.entity}`,
      );
    }

    const entityId =
      entry.entityId === null || entry.entityId === undefined
        ? null
        : String(entry.entityId);
    if (entityId !== null && entityId.length > 64) {
      throw new HrAuditValidationError('entityId quá 64 ký tự');
    }

    const reason = entry.reason?.trim() || null;
    if (REASON_REQUIRED_ACTIONS.includes(entry.action) && !reason) {
      throw new HrAuditValidationError(
        `${entry.action} bắt buộc phải có lý do`,
      );
    }
    if (reason && reason.length > MAX_REASON) {
      throw new HrAuditValidationError(`Lý do quá ${MAX_REASON} ký tự`);
    }

    const { actor } = entry;
    return {
      actorAccountId: actor.accountId,
      actorName: actor.name?.slice(0, 255) ?? null,
      actorRoles: actor.roles ?? [],
      action: entry.action,
      entity: entry.entity,
      entityId,
      oldValue: prepareValue(entry.oldValue),
      newValue: prepareValue(entry.newValue),
      reason,
      ip: actor.ip?.slice(0, 64) ?? null,
      userAgent: actor.userAgent?.slice(0, 512) ?? null,
      requestId: actor.requestId?.slice(0, 64) ?? null,
    };
  }
}
