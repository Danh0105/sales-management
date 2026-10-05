import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Mã do hệ thống sinh cho danh mục tổ chức (quyết định 30/09/2026).
 *
 * - `hr.org_unit_code_seq` → đơn vị `DV` + 4 số; `hr.position_code_seq` →
 *   chức danh `CD` + 4 số. Bắt đầu SAU mã `DV####`/`CD####` lớn nhất đang có.
 *   Mã đã có (kể cả mã tạo tay định dạng khác) giữ nguyên.
 * - `hr.org_backfill_runs`: mỗi lần CLI `hr:org:backfill --apply` thành công
 *   ghi một dòng — `plan_hash` (SHA-256 của kế hoạch chuẩn hoá) là khoá
 *   idempotency: chạy lại đúng kế hoạch đó → không làm gì. `ref_codes` lưu
 *   ref tạm → mã được cấp, để lần chạy sau không khai lại cùng một ref.
 *
 * Rủi ro: SAFE — chỉ tạo sequence và bảng mới trong schema hr, không đổi dữ liệu.
 * Rollback: `down()` từ chối nếu đã có lần backfill; gỡ bảng và sequence
 * (mã đã cấp trong org_units/positions giữ nguyên).
 */
export class HrOrgCodeSequences1791700000900 implements MigrationInterface {
  name = 'HrOrgCodeSequences1791700000900';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [seq, table, prefix] of [
      ['org_unit_code_seq', 'org_units', 'DV'],
      ['position_code_seq', 'positions', 'CD'],
    ]) {
      await queryRunner.query(`
        CREATE SEQUENCE IF NOT EXISTS "hr"."${seq}"
          AS integer START WITH 1 MINVALUE 1 MAXVALUE 9999 NO CYCLE
      `);
      await queryRunner.query(`
        SELECT setval(
          '"hr"."${seq}"',
          GREATEST(coalesce(max(substring("code" FROM 3)::integer), 0), 1),
          count(*) > 0
        )
        FROM "hr"."${table}"
        WHERE "code" ~ '^${prefix}[0-9]{4}$'
      `);
    }
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."org_backfill_runs" (
        "id" SERIAL NOT NULL,
        "plan_hash" varchar(64) NOT NULL,
        "reason" text NOT NULL,
        "ref_codes" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "summary" jsonb NOT NULL,
        "applied_by" varchar(100) NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_org_backfill_runs" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_hr_org_backfill_runs_plan" UNIQUE ("plan_hash"),
        CONSTRAINT "CHK_hr_org_backfill_runs_hash" CHECK ("plan_hash" ~ '^[0-9a-f]{64}$')
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('"hr"."org_backfill_runs"') IS NOT NULL
           AND EXISTS (SELECT 1 FROM "hr"."org_backfill_runs") THEN
          RAISE EXCEPTION 'hr.org_backfill_runs có dữ liệu — rollback tay sau khi backup';
        END IF;
      END $$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."org_backfill_runs"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "hr"."position_code_seq"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "hr"."org_unit_code_seq"`);
  }
}
