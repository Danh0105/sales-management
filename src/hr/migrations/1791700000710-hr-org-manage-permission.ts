import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Quyền `ORG_MANAGE` (Phase 1.1): quản lý cơ cấu tổ chức (đơn vị, revision,
 * lãnh đạo đơn vị, chức danh) — LUÔN kèm scope. Không gồm hồ sơ nhân viên,
 * điều chuyển/bổ nhiệm nhân viên hay cấp quyền HR.
 *
 * Gán mặc định: HR role `HR_OFFICER`; role cũ `nhansu` (scope COMPANY, qua
 * tầng HR access — không sửa `employee.roles`).
 *
 * Rủi ro: SAFE — chỉ INSERT danh mục, idempotent.
 * Rollback: `down()` gỡ đúng các dòng này nếu chưa có quyền lẻ/assignment nào dùng.
 */
export class HrOrgManagePermission1791700000710 implements MigrationInterface {
  name = 'HrOrgManagePermission1791700000710';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "hr"."permissions" ("code", "description", "is_sensitive") VALUES
        ('ORG_MANAGE', 'Quản lý cơ cấu tổ chức (đơn vị, lãnh đạo đơn vị, chức danh)', false)
      ON CONFLICT ("code") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "hr"."hr_role_permissions" ("role_code", "permission_code") VALUES
        ('HR_OFFICER', 'ORG_MANAGE')
      ON CONFLICT ("role_code", "permission_code") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "hr"."role_permissions" ("role", "permission_code", "scope") VALUES
        ('nhansu', 'ORG_MANAGE', 'COMPANY')
      ON CONFLICT ("role", "permission_code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."account_permission_grants" WHERE "permission_code" = 'ORG_MANAGE') THEN
          RAISE EXCEPTION 'ORG_MANAGE đang được cấp lẻ — thu hồi trước khi rollback';
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DELETE FROM "hr"."role_permissions" WHERE "role" = 'nhansu' AND "permission_code" = 'ORG_MANAGE'`,
    );
    await queryRunner.query(
      `DELETE FROM "hr"."hr_role_permissions" WHERE "role_code" = 'HR_OFFICER' AND "permission_code" = 'ORG_MANAGE'`,
    );
    await queryRunner.query(
      `DELETE FROM "hr"."permissions" WHERE "code" = 'ORG_MANAGE'`,
    );
  }
}
