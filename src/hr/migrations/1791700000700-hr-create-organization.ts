import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Cơ cấu tổ chức HR (Phase 1.1) — có ngày hiệu lực, không sửa đè lịch sử.
 *
 * - `org_units`: định danh cố định của một đơn vị (mã không đổi).
 * - `org_unit_revisions`: thuộc tính theo thời gian (loại, tên, đơn vị cha,
 *   trạng thái). Thay đổi = revision mới + đóng revision trước ở ngày trước đó.
 *   Chỉ một revision mở (`effective_to IS NULL`) cho mỗi đơn vị; revision chỉ
 *   được thêm vào CUỐI (service, dưới advisory lock) → không chồng lấn.
 * - `org_unit_leaders`: lãnh đạo đơn vị theo thời gian (DEPARTMENT_HEAD,
 *   BRANCH_DIRECTOR, COMPANY_DIRECTOR, DEPUTY). `is_approval_authority` đánh
 *   dấu người duyệt chính — tối đa một người cho mỗi (đơn vị, vai trò) tại
 *   một thời điểm (service). Kết thúc = `effective_to`, không xoá.
 * - `positions`: danh mục chức danh.
 * - `legacy_org_mappings`: gợi ý đơn vị từ phòng ban / role cũ cho script
 *   import (Phase 1.2) — không FK sang bảng cũ.
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới trong schema hr.
 * Rollback: `down()` từ chối nếu có dữ liệu.
 */
export class HrCreateOrganization1791700000700 implements MigrationInterface {
  name = 'HrCreateOrganization1791700000700';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."org_units" (
        "id" SERIAL NOT NULL,
        "code" varchar(32) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_org_units" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_hr_org_units_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_org_units_code" ON "hr"."org_units" ("code")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."org_unit_revisions" (
        "id" SERIAL NOT NULL,
        "org_unit_id" integer NOT NULL,
        "unit_type" varchar(16) NOT NULL,
        "name" varchar(200) NOT NULL,
        "parent_id" integer,
        "status" varchar(16) NOT NULL,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "reason" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        CONSTRAINT "PK_hr_org_unit_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_org_unit_revisions_unit" FOREIGN KEY ("org_unit_id")
          REFERENCES "hr"."org_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_org_unit_revisions_parent" FOREIGN KEY ("parent_id")
          REFERENCES "hr"."org_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_org_unit_revisions_type"
          CHECK ("unit_type" IN ('COMPANY','BRANCH','DEPARTMENT','TEAM')),
        CONSTRAINT "CHK_hr_org_unit_revisions_status" CHECK ("status" IN ('ACTIVE','INACTIVE')),
        CONSTRAINT "CHK_hr_org_unit_revisions_parent"
          CHECK (("unit_type" = 'COMPANY') = ("parent_id" IS NULL)),
        CONSTRAINT "CHK_hr_org_unit_revisions_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "org_unit_id"),
        CONSTRAINT "CHK_hr_org_unit_revisions_period"
          CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
        CONSTRAINT "CHK_hr_org_unit_revisions_name" CHECK (length(trim("name")) > 0),
        CONSTRAINT "CHK_hr_org_unit_revisions_reason" CHECK (length(trim("reason")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_org_unit_revisions_start"
        ON "hr"."org_unit_revisions" ("org_unit_id", "effective_from")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_org_unit_revisions_open"
        ON "hr"."org_unit_revisions" ("org_unit_id") WHERE "effective_to" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_org_unit_revisions_parent"
        ON "hr"."org_unit_revisions" ("parent_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."positions" (
        "id" SERIAL NOT NULL,
        "code" varchar(32) NOT NULL,
        "name" varchar(200) NOT NULL,
        "level" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" integer,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_positions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_hr_positions_code" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
        CONSTRAINT "CHK_hr_positions_name" CHECK (length(trim("name")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_positions_code" ON "hr"."positions" ("code")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."org_unit_leaders" (
        "id" SERIAL NOT NULL,
        "org_unit_id" integer NOT NULL,
        "employee_id" integer NOT NULL,
        "leader_role" varchar(24) NOT NULL,
        "position_id" integer,
        "is_approval_authority" boolean NOT NULL DEFAULT false,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "reason" text NOT NULL,
        "end_reason" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "ended_at" timestamptz,
        "ended_by" integer,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_org_unit_leaders" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_org_unit_leaders_unit" FOREIGN KEY ("org_unit_id")
          REFERENCES "hr"."org_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_org_unit_leaders_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_org_unit_leaders_position" FOREIGN KEY ("position_id")
          REFERENCES "hr"."positions"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_org_unit_leaders_role"
          CHECK ("leader_role" IN ('DEPARTMENT_HEAD','BRANCH_DIRECTOR','COMPANY_DIRECTOR','DEPUTY')),
        CONSTRAINT "CHK_hr_org_unit_leaders_deputy_authority"
          CHECK (NOT ("leader_role" = 'DEPUTY' AND "is_approval_authority")),
        CONSTRAINT "CHK_hr_org_unit_leaders_period"
          CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
        CONSTRAINT "CHK_hr_org_unit_leaders_reason" CHECK (length(trim("reason")) > 0),
        CONSTRAINT "CHK_hr_org_unit_leaders_end"
          CHECK (("effective_to" IS NULL) = ("end_reason" IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_org_unit_leaders_unit"
        ON "hr"."org_unit_leaders" ("org_unit_id", "leader_role")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."legacy_org_mappings" (
        "id" SERIAL NOT NULL,
        "source_type" varchar(16) NOT NULL,
        "source_value" varchar(100) NOT NULL,
        "org_unit_id" integer NOT NULL,
        "priority" integer NOT NULL DEFAULT 100,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_legacy_org_mappings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_legacy_org_mappings_unit" FOREIGN KEY ("org_unit_id")
          REFERENCES "hr"."org_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_legacy_org_mappings_source" CHECK ("source_type" IN ('DEPARTMENT','ROLE')),
        CONSTRAINT "CHK_hr_legacy_org_mappings_value" CHECK (length(trim("source_value")) > 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_legacy_org_mappings_active"
        ON "hr"."legacy_org_mappings" ("source_type", "source_value") WHERE "is_active"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'legacy_org_mappings',
      'org_unit_leaders',
      'positions',
      'org_unit_revisions',
      'org_units',
    ];
    for (const table of tables) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('"hr"."${table}"') IS NOT NULL
             AND EXISTS (SELECT 1 FROM "hr"."${table}") THEN
            RAISE EXCEPTION 'hr.${table} có dữ liệu — rollback tay sau khi backup';
          END IF;
        END $$
      `);
    }
    for (const table of tables) {
      await queryRunner.query(`DROP TABLE IF EXISTS "hr"."${table}"`);
    }
  }
}
