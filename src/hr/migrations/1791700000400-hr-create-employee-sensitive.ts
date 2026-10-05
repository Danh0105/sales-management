import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Hồ sơ nhân sự tối giản + dữ liệu định danh nhạy cảm (Task 0.4B).
 *
 * - `hr.employees`: hồ sơ HR, TÁCH khỏi tài khoản đăng nhập (`account_id`
 *   nullable — nhân sự chưa có tài khoản vẫn có hồ sơ). Phase 1 mở rộng bằng
 *   migration additive (phòng ban, chức danh...).
 * - `employee_identity_documents` / `employee_bank_accounts` /
 *   `employee_tax_profiles` / `employee_insurance_profiles`: số nhạy cảm lưu
 *   3 cột — `*_encrypted` (AES-256-GCM, `hrenc:`), `*_last4` (để hiện dạng che,
 *   không cần giải mã), `*_hash` (blind index HMAC, `hbi:`) cho chống trùng.
 *   KHÔNG có cột plaintext. CHECK chặn ghi nhầm plaintext vào cột mã hoá.
 * - Unique trên cột hash chặn trùng trong cùng version khoá HMAC; ứng dụng
 *   kiểm tra trùng qua mọi version (`HrBlindIndexService.candidates`).
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới trong schema hr, không đụng bảng cũ.
 * Rollback: `down()` từ chối nếu bất kỳ bảng nào đã có dữ liệu (rollback tay
 * sau khi backup — dữ liệu mã hoá cần cả key để đọc lại).
 */
export class HrCreateEmployeeSensitive1791700000400 implements MigrationInterface {
  name = 'HrCreateEmployeeSensitive1791700000400';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const encrypted = (col: string) =>
      `CHECK ("${col}" ~ '^hrenc:[0-9]+:v[1-9][0-9]*:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$')`;
    const hash = (col: string) =>
      `CHECK ("${col}" ~ '^hbi:[0-9]+:v[1-9][0-9]*:[A-Za-z0-9_-]+$')`;
    const last4 = (col: string) => `CHECK ("${col}" ~ '^[A-Z0-9]{4}$')`;
    const audit = `
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" integer`;

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employees" (
        "id" SERIAL NOT NULL,
        "employee_code" varchar(32) NOT NULL,
        "full_name" varchar(200) NOT NULL,
        "account_id" integer,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        ${audit},
        CONSTRAINT "PK_hr_employees" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_employees_account" FOREIGN KEY ("account_id")
          REFERENCES "public"."employee"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_employees_code" CHECK ("employee_code" ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
        CONSTRAINT "CHK_hr_employees_full_name" CHECK (length(trim("full_name")) > 0),
        CONSTRAINT "CHK_hr_employees_status" CHECK ("status" IN ('ACTIVE','INACTIVE'))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_employees_code"
        ON "hr"."employees" ("employee_code")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_employees_account"
        ON "hr"."employees" ("account_id") WHERE "account_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_identity_documents" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "document_type" varchar(16) NOT NULL,
        "number_encrypted" text NOT NULL,
        "number_last4" varchar(4) NOT NULL,
        "number_hash" varchar(96) NOT NULL,
        "issued_on" date,
        "expires_on" date,
        "issued_place" varchar(255),
        ${audit},
        CONSTRAINT "PK_hr_employee_identity_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_identity_documents_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_identity_documents_type"
          CHECK ("document_type" IN ('CCCD','CMND','PASSPORT','WORK_PERMIT')),
        CONSTRAINT "CHK_hr_identity_documents_encrypted" ${encrypted('number_encrypted')},
        CONSTRAINT "CHK_hr_identity_documents_hash" ${hash('number_hash')},
        CONSTRAINT "CHK_hr_identity_documents_last4" ${last4('number_last4')},
        CONSTRAINT "CHK_hr_identity_documents_period"
          CHECK ("expires_on" IS NULL OR "issued_on" IS NULL OR "expires_on" >= "issued_on")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_identity_documents_employee_type"
        ON "hr"."employee_identity_documents" ("employee_id", "document_type")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_identity_documents_hash"
        ON "hr"."employee_identity_documents" ("number_hash")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_bank_accounts" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "bank_code" varchar(20) NOT NULL,
        "bank_name" varchar(200) NOT NULL,
        "branch_name" varchar(200),
        "account_holder_name" varchar(200) NOT NULL,
        "account_number_encrypted" text NOT NULL,
        "account_number_last4" varchar(4) NOT NULL,
        "account_number_hash" varchar(96) NOT NULL,
        ${audit},
        CONSTRAINT "PK_hr_employee_bank_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_bank_accounts_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_bank_accounts_bank_code" CHECK ("bank_code" ~ '^[A-Z0-9]{2,20}$'),
        CONSTRAINT "CHK_hr_bank_accounts_encrypted" ${encrypted('account_number_encrypted')},
        CONSTRAINT "CHK_hr_bank_accounts_hash" ${hash('account_number_hash')},
        CONSTRAINT "CHK_hr_bank_accounts_last4" ${last4('account_number_last4')}
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_bank_accounts_employee"
        ON "hr"."employee_bank_accounts" ("employee_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_bank_accounts_number"
        ON "hr"."employee_bank_accounts" ("bank_code", "account_number_hash")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_tax_profiles" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "tax_number_encrypted" text NOT NULL,
        "tax_number_last4" varchar(4) NOT NULL,
        "tax_number_hash" varchar(96) NOT NULL,
        ${audit},
        CONSTRAINT "PK_hr_employee_tax_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_tax_profiles_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_tax_profiles_encrypted" ${encrypted('tax_number_encrypted')},
        CONSTRAINT "CHK_hr_tax_profiles_hash" ${hash('tax_number_hash')},
        CONSTRAINT "CHK_hr_tax_profiles_last4" ${last4('tax_number_last4')}
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_tax_profiles_employee"
        ON "hr"."employee_tax_profiles" ("employee_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_tax_profiles_hash"
        ON "hr"."employee_tax_profiles" ("tax_number_hash")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_insurance_profiles" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "social_insurance_number_encrypted" text NOT NULL,
        "social_insurance_number_last4" varchar(4) NOT NULL,
        "social_insurance_number_hash" varchar(96) NOT NULL,
        ${audit},
        CONSTRAINT "PK_hr_employee_insurance_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_insurance_profiles_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_insurance_profiles_encrypted" ${encrypted('social_insurance_number_encrypted')},
        CONSTRAINT "CHK_hr_insurance_profiles_hash" ${hash('social_insurance_number_hash')},
        CONSTRAINT "CHK_hr_insurance_profiles_last4" ${last4('social_insurance_number_last4')}
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_insurance_profiles_employee"
        ON "hr"."employee_insurance_profiles" ("employee_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_insurance_profiles_hash"
        ON "hr"."employee_insurance_profiles" ("social_insurance_number_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const tables = [
      'employee_insurance_profiles',
      'employee_tax_profiles',
      'employee_bank_accounts',
      'employee_identity_documents',
      'employees',
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
