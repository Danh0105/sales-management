import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Import hồ sơ nhân viên từ decision file đã duyệt (Phase 1.2.4).
 *
 * - `employee_import_batches`: mỗi lần `hr:employees:import --apply` thành
 *   công ghi một dòng. `checksum` (SHA-256 nội dung file) là khoá idempotency:
 *   chạy lại đúng file đó → không làm gì. Không lưu nội dung file, email, SĐT
 *   hay đường dẫn local — chỉ số đếm.
 * - `employee_import_items`: một dòng cho mỗi hồ sơ được tạo từ batch. Giữ
 *   đơn vị tổ chức ĐỀ XUẤT trong decision file để Phase 1.4 (Employment
 *   History) dùng — KHÔNG phải nguồn sự thật về đơn vị, không ghi vào
 *   `hr.employees`.
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới trong schema hr.
 * Rollback: `down()` từ chối nếu có dữ liệu.
 */
export class HrEmployeeImportBatches1791700001000 implements MigrationInterface {
  name = 'HrEmployeeImportBatches1791700001000';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_import_batches" (
        "id" SERIAL NOT NULL,
        "batch_id" uuid NOT NULL,
        "checksum" varchar(64) NOT NULL,
        "reason" text NOT NULL,
        "import_count" integer NOT NULL,
        "skip_count" integer NOT NULL,
        "applied_by" varchar(100) NOT NULL,
        "applied_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_employee_import_batches" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_hr_employee_import_batches_batch" UNIQUE ("batch_id"),
        CONSTRAINT "UQ_hr_employee_import_batches_checksum" UNIQUE ("checksum"),
        CONSTRAINT "CHK_hr_employee_import_batches_checksum" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_hr_employee_import_batches_counts" CHECK ("import_count" >= 0 AND "skip_count" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_import_items" (
        "id" SERIAL NOT NULL,
        "batch_id" integer NOT NULL,
        "employee_id" integer NOT NULL,
        "account_id" integer NOT NULL,
        "proposed_org_unit_id" integer,
        CONSTRAINT "PK_hr_employee_import_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_employee_import_items_batch" FOREIGN KEY ("batch_id")
          REFERENCES "hr"."employee_import_batches"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_employee_import_items_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_employee_import_items_org_unit" FOREIGN KEY ("proposed_org_unit_id")
          REFERENCES "hr"."org_units"("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_hr_employee_import_items_employee" UNIQUE ("employee_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_hr_employee_import_items_batch"
        ON "hr"."employee_import_items" ("batch_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['employee_import_items', 'employee_import_batches']) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('"hr"."${table}"') IS NOT NULL
             AND EXISTS (SELECT 1 FROM "hr"."${table}") THEN
            RAISE EXCEPTION 'hr.${table} có dữ liệu — rollback tay sau khi backup';
          END IF;
        END $$
      `);
    }
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hr"."employee_import_items"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hr"."employee_import_batches"`,
    );
  }
}
