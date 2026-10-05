import { ConflictException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { hrToday } from '../common/effective-date';
import { HrAuditAction } from '../audit/hr-audit-action';
import { HrAuditActor } from '../audit/hr-audit-actor';
import { HrAuditService } from '../audit/hr-audit.service';
import {
  breaksAdminQuota,
  HR_ADMIN_QUOTA_LOCK,
  MIN_PROTECTED_HR_ADMINS,
  QuotaOperation,
  quotaErrorBody,
} from './hr-admin-quota';

export interface QuotaSimulation {
  /** Đếm như thể các assignment này không còn tính (thu hồi / sắp đổi). */
  excludeAssignmentIds?: number[];
  /** Đếm như thể các tài khoản này đã bị khoá / xoá. */
  excludeAccountIds?: number[];
}

export interface AssignmentChange {
  roleCode: string;
  scope: string;
  effectiveTo: string | null;
}

/**
 * NƠI DUY NHẤT tính và bảo vệ số quản trị HR tối thiểu. API cấp/thu hồi quyền
 * của HR và module employee cũ (khoá/xoá tài khoản) đều gọi vào đây — không
 * module nào tự đếm quản trị theo cách riêng.
 *
 * Mọi hàm `assert*` phải chạy trong transaction SAU `lock()`: đếm và ghi nằm
 * trong cùng một khoá, request đồng thời phải xếp hàng.
 */
@Injectable()
export class HrAccessSafetyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly audit: HrAuditService,
  ) {}

  /** Chờ tới lượt giữ khoá quota; tự nhả khi transaction commit/rollback. */
  async lock(manager: EntityManager): Promise<void> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('HrAccessSafetyService.lock phải gọi trong transaction');
    }
    await manager.query(`SELECT pg_advisory_xact_lock($1)`, [
      HR_ADMIN_QUOTA_LOCK,
    ]);
  }

  /**
   * HRM đã được cài trên DB này chưa (migration HR đã chạy). Chưa cài thì
   * không có quản trị nào để bảo vệ — module cũ chạy y như trước, kể cả trên
   * production trước khi chạy migration HR.
   */
  async isInstalled(manager: EntityManager): Promise<boolean> {
    const [row] = await manager.query<{ installed: boolean }[]>(
      `SELECT to_regclass('hr.account_role_assignments') IS NOT NULL
          AND to_regclass('hr.hr_role_permissions') IS NOT NULL AS installed`,
    );
    return row?.installed === true;
  }

  /** Tài khoản protected HR administrator (xem định nghĩa ở hr-admin-quota.ts). */
  async protectedAdminIds(
    manager: EntityManager,
    on: string = hrToday(),
    simulation: QuotaSimulation = {},
  ): Promise<number[]> {
    const rows = await manager.query<{ id: number }[]>(
      `SELECT DISTINCT a."account_id" AS id
         FROM "hr"."account_role_assignments" a
         JOIN "hr"."roles" r ON r."code" = a."role_code" AND r."is_active"
         JOIN "hr"."hr_role_permissions" p
           ON p."role_code" = a."role_code" AND p."permission_code" = 'ACCESS_ADMIN'
         JOIN "public"."employee" e ON e."id" = a."account_id" AND e."isActive" = true
        WHERE a."scope" IN ('COMPANY', 'ALL')
          AND a."revoked_at" IS NULL
          AND a."effective_from" <= $1::date
          AND a."effective_to" IS NULL
          AND NOT (a."id" = ANY($2::int[]))
          AND NOT (a."account_id" = ANY($3::int[]))
        ORDER BY 1`,
      [
        on,
        simulation.excludeAssignmentIds ?? [],
        simulation.excludeAccountIds ?? [],
      ],
    );
    return rows.map((r) => Number(r.id));
  }

  /**
   * Mọi tài khoản đang quản trị được toàn công ty hôm nay, KỂ CẢ admin tạm
   * thời (có effective_to) — chỉ để báo cáo, không dùng cho quota.
   */
  async activeAdminIds(
    manager: EntityManager,
    on: string = hrToday(),
  ): Promise<number[]> {
    const rows = await manager.query<{ id: number }[]>(
      `SELECT DISTINCT a."account_id" AS id
         FROM "hr"."account_role_assignments" a
         JOIN "hr"."roles" r ON r."code" = a."role_code" AND r."is_active"
         JOIN "hr"."hr_role_permissions" p
           ON p."role_code" = a."role_code" AND p."permission_code" = 'ACCESS_ADMIN'
         JOIN "public"."employee" e ON e."id" = a."account_id" AND e."isActive" = true
        WHERE a."scope" IN ('COMPANY', 'ALL')
          AND a."revoked_at" IS NULL
          AND a."effective_from" <= $1::date
          AND (a."effective_to" IS NULL OR a."effective_to" >= $1::date)
        ORDER BY 1`,
      [on],
    );
    return rows.map((r) => Number(r.id));
  }

  /** Thu hồi assignment có làm thiếu protected admin không → 409 nếu có. */
  async assertCanRevokeAssignment(
    manager: EntityManager,
    assignmentId: number,
  ) {
    return this.assertQuota(manager, 'revoke', {
      excludeAssignmentIds: [assignmentId],
    });
  }

  /**
   * Đổi role / scope / effectiveTo của một assignment (dùng cho API sửa
   * assignment nếu sau này có — hiện assignment là bất biến, chỉ thu hồi được).
   * Thêm effectiveTo cho protected admin = biến thành admin tạm thời → bị chặn
   * nếu làm công ty còn dưới mức tối thiểu.
   */
  async assertCanChangeAssignment(
    manager: EntityManager,
    assignmentId: number,
    accountId: number,
    next: AssignmentChange,
  ) {
    const on = hrToday();
    const before = await this.protectedAdminIds(manager, on);
    const after = new Set(
      await this.protectedAdminIds(manager, on, {
        excludeAssignmentIds: [assignmentId],
      }),
    );
    if (await this.wouldBeProtected(manager, accountId, next)) {
      after.add(accountId);
    }
    if (breaksAdminQuota(before.length, after.size)) {
      throw new ConflictException(
        quotaErrorBody('change', before.length, after.size),
      );
    }
    return { before: before.length, after: after.size };
  }

  /** Khoá hoặc xoá tài khoản có làm thiếu protected admin không → 409 nếu có. */
  async assertCanDeactivateAccount(
    manager: EntityManager,
    accountId: number,
    operation: 'deactivate' | 'delete' = 'deactivate',
  ) {
    return this.assertQuota(manager, operation, {
      excludeAccountIds: [accountId],
    });
  }

  /**
   * Chạy thao tác khoá/xoá tài khoản của module employee trong transaction có
   * khoá quota. `write(manager)` PHẢI ghi bằng `manager` được truyền vào để
   * nằm chung transaction với phép kiểm tra.
   *
   * - HRM chưa cài: chạy `write` như cũ, không kiểm tra gì.
   * - Xoá tài khoản còn lịch sử quyền HR: 409 (FK RESTRICT sẽ chặn đằng nào
   *   cũng chặn — trả 409 rõ ràng thay vì 500), khuyên khoá thay vì xoá.
   * - Tài khoản đang quản trị HR: ghi audit ACCOUNT_DEACTIVATE.
   */
  async guardAccountRemoval<T>(
    accountId: number,
    operation: 'deactivate' | 'delete',
    actor: HrAuditActor,
    write: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      if (!(await this.isInstalled(manager))) return write(manager);

      await this.lock(manager);

      if (
        operation === 'delete' &&
        (await this.hasHrAccessHistory(manager, accountId))
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HR_ACCESS_HISTORY',
          message:
            'Cannot delete this account because it has HR access history. Deactivate the account instead.',
          messageVi:
            'Không xoá được tài khoản đã từng được cấp quyền HR (cần giữ lịch sử). Hãy khoá tài khoản thay vì xoá.',
        });
      }

      const on = hrToday();
      const wasAdmin = (await this.activeAdminIds(manager, on)).includes(
        accountId,
      );
      const quota = await this.assertCanDeactivateAccount(
        manager,
        accountId,
        operation,
      );

      const result = await write(manager);

      if (wasAdmin) {
        await this.audit.record(manager, {
          actor,
          action: HrAuditAction.ACCOUNT_DEACTIVATE,
          entity: 'account',
          entityId: accountId,
          oldValue: { isActive: true },
          newValue: {
            isActive: false,
            operation,
            protectedAdminCount: quota,
          },
          reason: `Tài khoản quản trị HR bị ${operation === 'delete' ? 'xoá' : 'khoá'} qua module employee`,
        });
      }
      return result;
    });
  }

  /** Tình trạng hiện tại — health check / cảnh báo khi dưới mức tối thiểu. */
  async getAdminStatus() {
    const manager = this.dataSource.manager;
    const on = hrToday();
    const protectedIds = await this.protectedAdminIds(manager, on);
    const activeIds = await this.activeAdminIds(manager, on);
    return {
      on,
      minimum: MIN_PROTECTED_HR_ADMINS,
      protectedAdminCount: protectedIds.length,
      protectedAdminAccountIds: protectedIds,
      temporaryAdminAccountIds: activeIds.filter(
        (id) => !protectedIds.includes(id),
      ),
      healthy: protectedIds.length >= MIN_PROTECTED_HR_ADMINS,
    };
  }

  private async assertQuota(
    manager: EntityManager,
    operation: QuotaOperation,
    simulation: QuotaSimulation,
  ) {
    const on = hrToday();
    const before = await this.protectedAdminIds(manager, on);
    const after = await this.protectedAdminIds(manager, on, simulation);
    if (breaksAdminQuota(before.length, after.length)) {
      throw new ConflictException(
        quotaErrorBody(operation, before.length, after.length),
      );
    }
    return { before: before.length, after: after.length };
  }

  private async wouldBeProtected(
    manager: EntityManager,
    accountId: number,
    next: AssignmentChange,
  ): Promise<boolean> {
    if (next.effectiveTo !== null) return false;
    if (!['COMPANY', 'ALL'].includes(next.scope)) return false;
    const [row] = await manager.query<{ ok: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM "hr"."roles" r
           JOIN "hr"."hr_role_permissions" p
             ON p."role_code" = r."code" AND p."permission_code" = 'ACCESS_ADMIN'
          WHERE r."code" = $1 AND r."is_active"
       ) AND EXISTS (
         SELECT 1 FROM "public"."employee" e WHERE e."id" = $2 AND e."isActive" = true
       ) AS ok`,
      [next.roleCode, accountId],
    );
    return row?.ok === true;
  }

  private async hasHrAccessHistory(
    manager: EntityManager,
    accountId: number,
  ): Promise<boolean> {
    const [row] = await manager.query<{ has: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "hr"."account_role_assignments" WHERE "account_id" = $1)
           OR EXISTS (SELECT 1 FROM "hr"."account_permission_grants" WHERE "account_id" = $1)
           AS has`,
      [accountId],
    );
    return row?.has === true;
  }
}
