import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Phân quyền HR: danh mục quyền, quyền theo role, quyền cấp riêng từng tài khoản.
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới trong schema `hr` và seed dữ liệu vào chính
 * các bảng đó. FK tới `public.employee(id)` dùng ON DELETE RESTRICT: không xoá
 * được tài khoản còn quyền HR (thay vì âm thầm mất lịch sử cấp quyền).
 *
 * Scope lưu dạng varchar + CHECK thay vì enum Postgres để thêm giá trị sau này
 * không cần `ALTER TYPE`.
 *
 * Seed mặc định cố ý hẹp:
 * - `nhansu`: xem/sửa hồ sơ, xem file, audit, tham số, ngày lễ, xem cấu hình quyền — COMPANY.
 * - `director`: xem hồ sơ, audit, cấu hình quyền — COMPANY.
 * - `director_la`: xem hồ sơ — BRANCH (chưa có dữ liệu chi nhánh nên hiện chưa thấy ai).
 * - Quyền nhạy cảm (IDENTITY_REVEAL, BANK_REVEAL, SALARY_VIEW, ACCESS_ADMIN) KHÔNG
 *   cấp cho role nào: chỉ cấp riêng từng người qua `account_permission_grants`.
 *
 * Rollback: `down()` từ chối nếu đã có quyền cấp riêng cho tài khoản (dữ liệu
 * vận hành thật); bảng danh mục và quyền theo role chỉ chứa seed nên gỡ được.
 */
export class HrCreateAccessTables1791700000100 implements MigrationInterface {
  name = 'HrCreateAccessTables1791700000100';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."permissions" (
        "code" varchar(64) NOT NULL,
        "description" text NOT NULL,
        "is_sensitive" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_permissions" PRIMARY KEY ("code")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."role_permissions" (
        "id" SERIAL NOT NULL,
        "role" varchar(64) NOT NULL,
        "permission_code" varchar(64) NOT NULL,
        "scope" varchar(16) NOT NULL,
        "scope_ref_id" integer,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_role_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_hr_role_permissions_role_permission" UNIQUE ("role", "permission_code"),
        CONSTRAINT "FK_hr_role_permissions_permission" FOREIGN KEY ("permission_code")
          REFERENCES "hr"."permissions"("code") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_role_permissions_scope"
          CHECK ("scope" IN ('SELF','TEAM','ORG_UNIT','BRANCH','COMPANY','ALL'))
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."account_permission_grants" (
        "id" SERIAL NOT NULL,
        "account_id" integer NOT NULL,
        "permission_code" varchar(64) NOT NULL,
        "scope" varchar(16) NOT NULL,
        "scope_ref_id" integer,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "reason" text NOT NULL,
        "granted_by" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_account_permission_grants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_account_grants_account" FOREIGN KEY ("account_id")
          REFERENCES "public"."employee"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_account_grants_granted_by" FOREIGN KEY ("granted_by")
          REFERENCES "public"."employee"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_account_grants_permission" FOREIGN KEY ("permission_code")
          REFERENCES "hr"."permissions"("code") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_account_grants_scope"
          CHECK ("scope" IN ('SELF','TEAM','ORG_UNIT','BRANCH','COMPANY','ALL')),
        CONSTRAINT "CHK_hr_account_grants_period"
          CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
        CONSTRAINT "CHK_hr_account_grants_reason" CHECK (length(trim("reason")) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_account_grants_lookup"
        ON "hr"."account_permission_grants" ("account_id", "permission_code")
    `);

    await queryRunner.query(`
      INSERT INTO "hr"."permissions" ("code", "description", "is_sensitive") VALUES
        ('EMPLOYEE_VIEW',    'Xem hồ sơ nhân sự (không gồm dữ liệu nhạy cảm)', false),
        ('EMPLOYEE_EDIT',    'Sửa hồ sơ nhân sự', false),
        ('IDENTITY_REVEAL',  'Xem đầy đủ CCCD/CMND/hộ chiếu', true),
        ('BANK_REVEAL',      'Xem đầy đủ số tài khoản ngân hàng', true),
        ('SALARY_VIEW',      'Xem lương', true),
        ('FILE_VIEW',        'Xem/tải tài liệu nhân sự', false),
        ('AUDIT_VIEW',       'Xem nhật ký audit HR', false),
        ('PARAMETER_MANAGE', 'Quản lý tham số chính sách HR', false),
        ('HOLIDAY_MANAGE',   'Quản lý ngày lễ', false),
        ('ACCESS_VIEW',      'Xem cấu hình phân quyền HR', false),
        ('ACCESS_ADMIN',     'Cấp/thu hồi quyền HR', true)
      ON CONFLICT ("code") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "hr"."role_permissions" ("role", "permission_code", "scope") VALUES
        ('nhansu',      'EMPLOYEE_VIEW',    'COMPANY'),
        ('nhansu',      'EMPLOYEE_EDIT',    'COMPANY'),
        ('nhansu',      'FILE_VIEW',        'COMPANY'),
        ('nhansu',      'AUDIT_VIEW',       'COMPANY'),
        ('nhansu',      'PARAMETER_MANAGE', 'COMPANY'),
        ('nhansu',      'HOLIDAY_MANAGE',   'COMPANY'),
        ('nhansu',      'ACCESS_VIEW',      'COMPANY'),
        ('director',    'EMPLOYEE_VIEW',    'COMPANY'),
        ('director',    'AUDIT_VIEW',       'COMPANY'),
        ('director',    'ACCESS_VIEW',      'COMPANY'),
        ('director_la', 'EMPLOYEE_VIEW',    'BRANCH')
      ON CONFLICT ("role", "permission_code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."account_permission_grants") THEN
          RAISE EXCEPTION 'hr.account_permission_grants có dữ liệu — rollback tay sau khi backup';
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hr"."account_permission_grants"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."role_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."permissions"`);
  }
}
