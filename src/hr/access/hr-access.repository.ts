import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { HrAccountPermissionGrant } from './entities/hr-account-permission-grant.entity';
import { HrPermissionEntity } from './entities/hr-permission.entity';
import { HrRolePermission } from './entities/hr-role-permission.entity';
import { HrScope } from './hr-permission';

export interface HrAccountSnapshot {
  id: number;
  roles: string[];
  isActive: boolean;
}

export interface HrRoleAssignmentGrantRow {
  assignmentId: number;
  roleCode: string;
  scope: HrScope;
  scopeRefId: number | null;
  permissionCode: string;
  /** YYYY-MM-DD (ép ::text trong SQL — tránh pg parse `date` thành Date theo giờ server). */
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Mọi truy vấn của phần phân quyền đi qua đây — service chỉ chứa luật, để test
 * được mà không cần database.
 */
@Injectable()
export class HrAccessRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(HrPermissionEntity)
    private readonly permissions: Repository<HrPermissionEntity>,
    @InjectRepository(HrRolePermission)
    private readonly rolePermissions: Repository<HrRolePermission>,
    @InjectRepository(HrAccountPermissionGrant)
    private readonly accountGrants: Repository<HrAccountPermissionGrant>,
  ) {}

  /**
   * Đọc role và trạng thái tài khoản MỚI NHẤT từ `public.employee` (chỉ đọc).
   * Không dùng role trong JWT: token sống 1 ngày, role bị rút hay tài khoản bị
   * khoá thì token cũ vẫn mang quyền cũ.
   */
  async findAccount(accountId: number): Promise<HrAccountSnapshot | null> {
    const rows = await this.dataSource.query<
      { id: number; roles: string[] | null; isActive: boolean | null }[]
    >(
      `SELECT "id", "roles", "isActive" FROM "public"."employee" WHERE "id" = $1`,
      [accountId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      roles: row.roles ?? [],
      isActive: row.isActive === true,
    };
  }

  findRolePermissions(
    roles: string[],
    permission?: string,
  ): Promise<HrRolePermission[]> {
    if (!roles.length) return Promise.resolve([]);
    return this.rolePermissions.find({
      where: {
        role: In(roles),
        ...(permission ? { permissionCode: permission } : {}),
      },
      order: { role: 'ASC', permissionCode: 'ASC' },
    });
  }

  /** Quyền cấp riêng còn hiệu lực vào ngày `on` (YYYY-MM-DD, `effective_to` inclusive). */
  findActiveAccountGrants(
    accountId: number,
    on: string,
    permission?: string,
  ): Promise<HrAccountPermissionGrant[]> {
    const qb = this.accountGrants
      .createQueryBuilder('g')
      .where('g.accountId = :accountId', { accountId })
      .andWhere('g.effectiveFrom <= :on', { on })
      .andWhere('(g.effectiveTo IS NULL OR g.effectiveTo >= :on)', { on })
      .orderBy('g.permissionCode', 'ASC')
      .addOrderBy('g.id', 'ASC');
    if (permission)
      qb.andWhere('g.permissionCode = :permission', { permission });
    return qb.getMany();
  }

  /**
   * Quyền sinh ra từ HR role đã gán, còn hiệu lực vào ngày `on`.
   *
   * Assignment đã thu hồi mất hiệu lực NGAY trong ngày thu hồi (giờ Việt Nam):
   * `revoked_at::date > on` chỉ giữ lại hiệu lực cho các ngày TRƯỚC ngày thu hồi.
   * Role đã tắt (`is_active = false`) không sinh quyền nào.
   */
  findActiveRoleAssignmentGrants(
    accountId: number,
    on: string,
    permission?: string,
  ): Promise<HrRoleAssignmentGrantRow[]> {
    return this.dataSource.query<HrRoleAssignmentGrantRow[]>(
      `SELECT a."id" AS "assignmentId", a."role_code" AS "roleCode",
              a."scope", a."scope_ref_id" AS "scopeRefId",
              p."permission_code" AS "permissionCode",
              a."effective_from"::text AS "effectiveFrom",
              a."effective_to"::text AS "effectiveTo"
         FROM "hr"."account_role_assignments" a
         JOIN "hr"."roles" r ON r."code" = a."role_code" AND r."is_active"
         JOIN "hr"."hr_role_permissions" p ON p."role_code" = a."role_code"
        WHERE a."account_id" = $1
          AND a."effective_from" <= $2::date
          AND (a."effective_to" IS NULL OR a."effective_to" >= $2::date)
          AND (a."revoked_at" IS NULL
               OR (a."revoked_at" AT TIME ZONE 'Asia/Ho_Chi_Minh')::date > $2::date)
          AND ($3::varchar IS NULL OR p."permission_code" = $3::varchar)
        ORDER BY p."permission_code", a."id"`,
      [accountId, on, permission ?? null],
    );
  }

  listPermissions(): Promise<HrPermissionEntity[]> {
    return this.permissions.find({ order: { code: 'ASC' } });
  }

  listRolePermissions(): Promise<HrRolePermission[]> {
    return this.rolePermissions.find({
      order: { role: 'ASC', permissionCode: 'ASC' },
    });
  }

  /** Toàn bộ lịch sử cấp quyền của một tài khoản, kể cả đã hết hạn. */
  listAccountGrantHistory(
    accountId: number,
  ): Promise<HrAccountPermissionGrant[]> {
    return this.accountGrants.find({
      where: { accountId },
      order: { effectiveFrom: 'DESC', id: 'DESC' },
    });
  }
}
