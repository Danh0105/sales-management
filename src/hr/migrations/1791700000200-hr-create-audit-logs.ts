import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Nhật ký audit của HR — append-only.
 *
 * App kết nối bằng superuser nên REVOKE UPDATE/DELETE không có tác dụng; chặn
 * bằng trigger (trigger chạy với cả superuser, trừ khi ai đó cố ý
 * `ALTER TABLE ... DISABLE TRIGGER` — thao tác DBA, để lại vết trong log Postgres).
 *
 * `actor_account_id` KHÔNG có FK tới `public.employee`: FK RESTRICT sẽ làm
 * `DELETE /employees/:id` của module cũ thất bại với mọi người từng thao tác
 * HR. Tên + role của người thao tác được chụp lại ngay lúc ghi.
 *
 * Rủi ro: SAFE — bảng, hàm, trigger mới, tất cả trong schema `hr`.
 * Rollback: `down()` từ chối nếu bảng đã có dòng nào (audit là bằng chứng).
 */
export class HrCreateAuditLogs1791700000200 implements MigrationInterface {
  name = 'HrCreateAuditLogs1791700000200';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."audit_logs" (
        "id" BIGSERIAL NOT NULL,
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "actor_account_id" integer,
        "actor_name" varchar(255),
        "actor_roles" text[] NOT NULL DEFAULT '{}',
        "action" varchar(64) NOT NULL,
        "entity" varchar(64) NOT NULL,
        "entity_id" varchar(64),
        "old_value" jsonb,
        "new_value" jsonb,
        "reason" text,
        "ip" varchar(64),
        "user_agent" varchar(512),
        "request_id" varchar(64),
        CONSTRAINT "PK_hr_audit_logs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_audit_logs_entity"
        ON "hr"."audit_logs" ("entity", "entity_id", "occurred_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_audit_logs_actor"
        ON "hr"."audit_logs" ("actor_account_id", "occurred_at" DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_audit_logs_action"
        ON "hr"."audit_logs" ("action", "occurred_at" DESC)
    `);

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "hr"."audit_logs_append_only"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'hr.audit_logs là append-only: không cho phép %', TG_OP
          USING ERRCODE = 'insufficient_privilege';
      END
      $fn$
    `);

    await queryRunner.query(`
      CREATE OR REPLACE TRIGGER "trg_hr_audit_logs_no_row_change"
        BEFORE UPDATE OR DELETE ON "hr"."audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "hr"."audit_logs_append_only"()
    `);
    await queryRunner.query(`
      CREATE OR REPLACE TRIGGER "trg_hr_audit_logs_no_truncate"
        BEFORE TRUNCATE ON "hr"."audit_logs"
        FOR EACH STATEMENT EXECUTE FUNCTION "hr"."audit_logs_append_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."audit_logs") THEN
          RAISE EXCEPTION 'hr.audit_logs có dữ liệu — không rollback tự động';
        END IF;
      END $$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."audit_logs"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "hr"."audit_logs_append_only"()`,
    );
  }
}
