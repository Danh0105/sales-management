import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chi tháng nhiều trường:
 * - Giám đốc duyệt một phần: dòng không duyệt đánh dấu `excluded`, không tính
 *   vào lệnh chi.
 * - Chi một phần: phần tiền từng dòng lúc duyệt (`approved_amount`), dòng nào
 *   đã chi (`spent`) và trạng thái chờ Thủ quỹ nhận lại phần dư.
 * Chỉ thêm cột (nullable hoặc có mặc định) và giá trị enum, không đổi dữ liệu.
 */
export class AddMonthlyPartialApprovalSpend1795600000000 implements MigrationInterface {
  name = 'AddMonthlyPartialApprovalSpend1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'PARTIALLY_SPENT'`,
    );
    await queryRunner.query(`
      ALTER TABLE "suggest_monthly_items"
      ADD COLUMN IF NOT EXISTS "approved_amount" numeric(18,2),
      ADD COLUMN IF NOT EXISTS "spent" boolean,
      ADD COLUMN IF NOT EXISTS "excluded" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "suggest_monthly_items"
      DROP COLUMN IF EXISTS "excluded",
      DROP COLUMN IF EXISTS "spent",
      DROP COLUMN IF EXISTS "approved_amount"
    `);
    // Giá trị enum PARTIALLY_SPENT giữ lại: PostgreSQL không xoá an toàn được.
  }
}
