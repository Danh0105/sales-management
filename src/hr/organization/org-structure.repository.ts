import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { OrgNode, OrgSnapshot } from './org-tree';

/** Khoá tư vấn cho MỌI thay đổi cơ cấu (đơn vị, revision, lãnh đạo) — tuần tự hoá. */
export const HR_ORG_STRUCTURE_LOCK = 791_700_411;

/**
 * Truy vấn cơ cấu theo ngày. Ngày luôn truyền vào dạng `YYYY-MM-DD` (giờ Việt
 * Nam do ứng dụng xác định) và so sánh trên cột `date` — không dùng
 * CURRENT_DATE của PostgreSQL.
 */
@Injectable()
export class OrgStructureRepository {
  async lock(manager: EntityManager) {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [
      HR_ORG_STRUCTURE_LOCK,
    ]);
  }

  /**
   * Revision hiệu lực tại `asOf` — MỘT định nghĩa dùng cho cả cây (`snapshot`)
   * và một đơn vị (`nodeAt`).
   */
  private nodesAt(manager: EntityManager, asOf: string, unitId?: number) {
    return manager.query<OrgNode[]>(
      `SELECT u."id", u."code", r."id" AS "revisionId", r."unit_type" AS "unitType",
              r."name", r."parent_id" AS "parentId", r."status",
              r."effective_from"::text AS "effectiveFrom",
              r."effective_to"::text AS "effectiveTo"
         FROM "hr"."org_units" u
         JOIN "hr"."org_unit_revisions" r ON r."org_unit_id" = u."id"
        WHERE r."effective_from" <= $1::date
          AND (r."effective_to" IS NULL OR r."effective_to" >= $1::date)
          ${unitId === undefined ? '' : 'AND u."id" = $2'}`,
      unitId === undefined ? [asOf] : [asOf, unitId],
    );
  }

  /** Cơ cấu tại `asOf` (gồm cả đơn vị INACTIVE — nơi dùng tự lọc). */
  async snapshot(manager: EntityManager, asOf: string): Promise<OrgSnapshot> {
    return new OrgSnapshot(asOf, await this.nodesAt(manager, asOf));
  }

  /** Một đơn vị tại `asOf`; không tồn tại / chưa có revision hiệu lực → null. */
  async nodeAt(
    manager: EntityManager,
    unitId: number,
    asOf: string,
  ): Promise<OrgNode | null> {
    const [node] = await this.nodesAt(manager, asOf, unitId);
    return node ?? null;
  }

  /** Mọi ngày bắt đầu revision sau `after` — các mốc cơ cấu có thể khác đi. */
  async checkpointsAfter(
    manager: EntityManager,
    after: string,
  ): Promise<string[]> {
    const rows = await manager.query<{ d: string }[]>(
      `SELECT DISTINCT "effective_from"::text AS "d"
         FROM "hr"."org_unit_revisions"
        WHERE "effective_from" > $1::date
        ORDER BY 1`,
      [after],
    );
    return rows.map((r) => r.d);
  }

  /** Lãnh đạo đơn vị còn hiệu lực trong khoảng [from, to]. */
  async leadersOverlapping(
    manager: EntityManager,
    orgUnitId: number,
    from: string,
    to: string | null,
  ) {
    return manager.query<
      {
        id: number;
        employeeId: number;
        leaderRole: string;
        isApprovalAuthority: boolean;
        effectiveFrom: string;
        effectiveTo: string | null;
      }[]
    >(
      `SELECT "id", "employee_id" AS "employeeId", "leader_role" AS "leaderRole",
              "is_approval_authority" AS "isApprovalAuthority",
              "effective_from"::text AS "effectiveFrom", "effective_to"::text AS "effectiveTo"
         FROM "hr"."org_unit_leaders"
        WHERE "org_unit_id" = $1
          AND ("effective_to" IS NULL OR "effective_to" >= $2::date)
          AND ($3::date IS NULL OR "effective_from" <= $3::date)`,
      [orgUnitId, from, to],
    );
  }

  /** Lãnh đạo hiệu lực tại `asOf` của nhiều đơn vị, kèm tên nhân viên. */
  async leadersAt(manager: EntityManager, asOf: string, orgUnitIds?: number[]) {
    return manager.query<
      {
        id: number;
        orgUnitId: number;
        employeeId: number;
        employeeCode: string;
        employeeName: string;
        employeeStatus: string;
        leaderRole: string;
        isApprovalAuthority: boolean;
        positionId: number | null;
        positionName: string | null;
        effectiveFrom: string;
        effectiveTo: string | null;
        version: number;
      }[]
    >(
      `SELECT l."id", l."org_unit_id" AS "orgUnitId", l."employee_id" AS "employeeId",
              e."employee_code" AS "employeeCode", e."full_name" AS "employeeName",
              e."status" AS "employeeStatus",
              l."leader_role" AS "leaderRole", l."is_approval_authority" AS "isApprovalAuthority",
              l."position_id" AS "positionId", p."name" AS "positionName",
              l."effective_from"::text AS "effectiveFrom", l."effective_to"::text AS "effectiveTo",
              l."version"
         FROM "hr"."org_unit_leaders" l
         JOIN "hr"."employees" e ON e."id" = l."employee_id"
         LEFT JOIN "hr"."positions" p ON p."id" = l."position_id"
        WHERE l."effective_from" <= $1::date
          AND (l."effective_to" IS NULL OR l."effective_to" >= $1::date)
          AND ($2::int[] IS NULL OR l."org_unit_id" = ANY($2::int[]))
        ORDER BY l."org_unit_id", l."leader_role", l."effective_from"`,
      [asOf, orgUnitIds ?? null],
    );
  }
}
