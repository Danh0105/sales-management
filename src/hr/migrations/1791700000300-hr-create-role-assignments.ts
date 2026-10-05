import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * HR role — tách hoàn toàn khỏi `public.employee.roles` (text[]) của hệ thống cũ.
 *
 * - `hr.roles`: danh mục HR role. Mã VIẾT HOA (`HR_ADMIN`) nên không bao giờ
 *   trùng role cũ (viết thường: `nhansu`, `director`...).
 * - `hr.hr_role_permissions`: role gồm những quyền nào (scope KHÔNG nằm ở đây).
 * - `hr.account_role_assignments`: gán role cho tài khoản + scope + thời hạn.
 *   Thu hồi = `revoked_at` (có hiệu lực ngay), không xoá dòng.
 *
 * Chống trùng: unique index một phần trên các assignment chưa thu hồi — chặn
 * cả khi hai request cấp cùng lúc (kiểm tra ở tầng code không đủ).
 *
 * `granted_by` / `revoked_by` không có FK: FK RESTRICT làm người TỪNG cấp quyền
 * không xoá được tài khoản ở module cũ. Cùng lý do, gỡ FK
 * `FK_hr_account_grants_granted_by` đã tạo ở 1791700000100.
 *
 * Rủi ro: SAFE — bảng mới trong schema hr; gỡ một FK của chính bảng hr (không
 * đổi dữ liệu, không khoá bảng cũ).
 * Rollback: `down()` từ chối nếu đã có assignment; KHÔNG tạo lại FK granted_by
 * (tạo lại có thể hỏng nếu tài khoản người cấp đã bị xoá).
 */
export class HrCreateRoleAssignments1791700000300 implements MigrationInterface {
  name = 'HrCreateRoleAssignments1791700000300';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hr"."account_permission_grants"
        DROP CONSTRAINT IF EXISTS "FK_hr_account_grants_granted_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."account_permission_grants"
        ALTER COLUMN "granted_by" DROP NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."roles" (
        "code" varchar(64) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_roles" PRIMARY KEY ("code"),
        CONSTRAINT "CHK_hr_roles_code" CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,63}$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."hr_role_permissions" (
        "role_code" varchar(64) NOT NULL,
        "permission_code" varchar(64) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_hr_role_permissions" PRIMARY KEY ("role_code", "permission_code"),
        CONSTRAINT "FK_hr_hr_role_permissions_role" FOREIGN KEY ("role_code")
          REFERENCES "hr"."roles"("code") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_hr_role_permissions_permission" FOREIGN KEY ("permission_code")
          REFERENCES "hr"."permissions"("code") ON DELETE RESTRICT
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."account_role_assignments" (
        "id" SERIAL NOT NULL,
        "account_id" integer NOT NULL,
        "role_code" varchar(64) NOT NULL,
        "scope" varchar(16) NOT NULL,
        "scope_ref_id" integer,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "reason" text NOT NULL,
        "granted_by" integer,
        "granted_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revoked_by" integer,
        "revoke_reason" text,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_account_role_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_role_assignments_account" FOREIGN KEY ("account_id")
          REFERENCES "public"."employee"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_role_assignments_role" FOREIGN KEY ("role_code")
          REFERENCES "hr"."roles"("code") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_role_assignments_scope"
          CHECK ("scope" IN ('SELF','TEAM','ORG_UNIT','BRANCH','COMPANY','ALL')),
        CONSTRAINT "CHK_hr_role_assignments_scope_ref"
          CHECK (("scope" IN ('ORG_UNIT','BRANCH')) = ("scope_ref_id" IS NOT NULL)),
        CONSTRAINT "CHK_hr_role_assignments_period"
          CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from"),
        CONSTRAINT "CHK_hr_role_assignments_reason" CHECK (length(trim("reason")) > 0),
        CONSTRAINT "CHK_hr_role_assignments_revoke"
          CHECK (("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL)
              OR ("revoked_at" IS NOT NULL AND length(trim(coalesce("revoke_reason", ''))) > 0))
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_role_assignments_active"
        ON "hr"."account_role_assignments"
        ("account_id", "role_code", "scope", (coalesce("scope_ref_id", 0)))
        WHERE "revoked_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_role_assignments_account"
        ON "hr"."account_role_assignments" ("account_id")
    `);

    await queryRunner.query(`
      INSERT INTO "hr"."roles" ("code", "name", "description") VALUES
        ('HR_ADMIN',            'Quản trị phân quyền HR',    'Cấp/thu hồi HR role, xem cấu hình quyền và audit'),
        ('HR_OFFICER',          'Chuyên viên nhân sự',       'Xem/sửa hồ sơ, tài liệu, tham số, ngày lễ'),
        ('HR_SENSITIVE_VIEWER', 'Xem dữ liệu định danh',     'Xem đầy đủ CCCD và số tài khoản ngân hàng'),
        ('PAYROLL_VIEWER',      'Xem lương',                 'Xem lương'),
        ('LINE_MANAGER',        'Quản lý trực tiếp',         'Xem hồ sơ nhân sự trong phạm vi được gán'),
        ('AUDITOR',             'Kiểm soát',                 'Xem audit và cấu hình quyền')
      ON CONFLICT ("code") DO NOTHING
    `);

    await queryRunner.query(`
      INSERT INTO "hr"."hr_role_permissions" ("role_code", "permission_code") VALUES
        ('HR_ADMIN',            'ACCESS_ADMIN'),
        ('HR_ADMIN',            'ACCESS_VIEW'),
        ('HR_ADMIN',            'AUDIT_VIEW'),
        ('HR_OFFICER',          'EMPLOYEE_VIEW'),
        ('HR_OFFICER',          'EMPLOYEE_EDIT'),
        ('HR_OFFICER',          'FILE_VIEW'),
        ('HR_OFFICER',          'PARAMETER_MANAGE'),
        ('HR_OFFICER',          'HOLIDAY_MANAGE'),
        ('HR_SENSITIVE_VIEWER', 'IDENTITY_REVEAL'),
        ('HR_SENSITIVE_VIEWER', 'BANK_REVEAL'),
        ('PAYROLL_VIEWER',      'SALARY_VIEW'),
        ('LINE_MANAGER',        'EMPLOYEE_VIEW'),
        ('AUDITOR',             'AUDIT_VIEW'),
        ('AUDITOR',             'ACCESS_VIEW')
      ON CONFLICT ("role_code", "permission_code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."account_role_assignments") THEN
          RAISE EXCEPTION 'hr.account_role_assignments có dữ liệu — rollback tay sau khi backup';
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hr"."account_role_assignments"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."hr_role_permissions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."roles"`);
  }
}
