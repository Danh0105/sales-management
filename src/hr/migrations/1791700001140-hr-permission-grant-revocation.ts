import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Phase 1.3 (quyết định 05/10/2026) — quyền lẻ `account_permission_grants`
 * trở thành cơ chế chính thức cấp quyền từng người (vd. HEALTH_DOCUMENT_VIEW)
 * qua Access Admin (cùng M1/M2/audit với cấp role):
 *
 * - Thu hồi giống role assignment: `revoked_at` (mất hiệu lực ngay trong ngày
 *   thu hồi, giờ Việt Nam), `revoked_by`, `revoke_reason` — không xoá dòng.
 * - `granted_by` đã cho phép NULL từ migration 0300 (bootstrap do CLI).
 *
 * Rủi ro: SAFE — chỉ thêm cột/ràng buộc/index; không đổi dữ liệu.
 * Rollback: `down()` từ chối nếu đã có quyền lẻ bị thu hồi.
 */
export class HrPermissionGrantRevocation1791700001140 implements MigrationInterface {
  name = 'HrPermissionGrantRevocation1791700001140';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hr"."account_permission_grants"
        ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "revoked_by" integer,
        ADD COLUMN IF NOT EXISTS "revoke_reason" text
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."account_permission_grants"
        ADD CONSTRAINT "FK_hr_account_grants_revoked_by" FOREIGN KEY ("revoked_by")
          REFERENCES "public"."employee"("id") ON DELETE RESTRICT,
        ADD CONSTRAINT "CHK_hr_account_grants_revocation"
          CHECK (("revoked_at" IS NULL) = ("revoke_reason" IS NULL))
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_account_grants_active"
        ON "hr"."account_permission_grants" ("account_id", "permission_code")
        WHERE "revoked_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."account_permission_grants"
                    WHERE "revoked_at" IS NOT NULL) THEN
          RAISE EXCEPTION 'Đã có quyền lẻ bị thu hồi — rollback tay sau khi backup';
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "hr"."IDX_hr_account_grants_active"`,
    );
    await queryRunner.query(`
      ALTER TABLE "hr"."account_permission_grants"
        DROP CONSTRAINT IF EXISTS "CHK_hr_account_grants_revocation",
        DROP CONSTRAINT IF EXISTS "FK_hr_account_grants_revoked_by"
    `);
  }
}
