import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CHI NGOÀI — Nội dung riêng cho dòng thêm ngoài các dòng Doanh Thu. Dòng đi kèm
 * Doanh Thu vẫn dùng Nội dung của Doanh Thu nên để NULL. Cột nullable, không đổi
 * dữ liệu cũ. Chạy lại an toàn.
 */
export class AddManagementExpenseContent1795400000000 implements MigrationInterface {
  name = 'AddManagementExpenseContent1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "management_expense_items" ADD COLUMN IF NOT EXISTS "content" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "management_expense_items" DROP COLUMN IF EXISTS "content"`,
    );
  }
}
