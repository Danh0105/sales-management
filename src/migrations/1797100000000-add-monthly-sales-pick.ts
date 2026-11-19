import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Đề xuất chi tháng" tích chọn (19/11/2026): kinh doanh tích Chi trường / Chi
 * Ban quản lí / Chi giáo viên trong một đề xuất (`suggest.approval_flow =
 * 'SALES_PICK'`). Thêm bảng nguồn của từng khoản và số tiền kinh doanh đề xuất.
 * Chỉ thêm cột nullable, không đổi dữ liệu; bản cũ chạy được trên schema mới.
 */
export class AddMonthlySalesPick1797100000000 implements MigrationInterface {
  name = 'AddMonthlySalesPick1797100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" ADD COLUMN IF NOT EXISTS "cashflow_source" character varying(20)`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'CHK_suggest_monthly_items_cashflow_source'
         ) THEN
           ALTER TABLE "suggest_monthly_items" ADD CONSTRAINT "CHK_suggest_monthly_items_cashflow_source"
             CHECK ("cashflow_source" IS NULL
               OR "cashflow_source" IN ('MANAGEMENT', 'SCHOOL_EXPENSE', 'SCHOOL_TEACHER'));
         END IF;
       END $$`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "sales_amount" numeric(18,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "suggest" DROP COLUMN IF EXISTS "sales_amount"`);
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" DROP CONSTRAINT IF EXISTS "CHK_suggest_monthly_items_cashflow_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" DROP COLUMN IF EXISTS "cashflow_source"`,
    );
  }
}
