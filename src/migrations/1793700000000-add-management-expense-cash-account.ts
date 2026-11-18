import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng Chi Ngoài: "Nguồn chi" của từng dòng (số hiệu tài khoản trong danh mục
 * Nguồn thu chi). Cột nullable, không default → chỉ đổi metadata, không ghi
 * lại dữ liệu; bản ghi cũ nhận NULL. `IF NOT EXISTS` để chạy an toàn cả khi
 * synchronize đã tạo trước.
 */
export class AddManagementExpenseCashAccount1793700000000 implements MigrationInterface {
  name = 'AddManagementExpenseCashAccount1793700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "management_expense_items" ADD COLUMN IF NOT EXISTS "cashAccount" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "management_expense_items" DROP COLUMN IF EXISTS "cashAccount"`,
    );
  }
}
