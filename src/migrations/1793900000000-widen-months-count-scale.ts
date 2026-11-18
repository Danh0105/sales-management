import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cột "Tháng" (dùng chung Doanh Thu, Chi Trường, Chi Ngoài): cho nhập tới 4
 * chữ số thập phân (VD 0,7619 tháng) thay vì 2. Tăng scale giữ nguyên giá trị
 * cũ (0.76 → 0.7600). Bảng nhỏ nhưng đổi scale vẫn ghi lại bảng → khóa ngắn.
 */
export class WidenMonthsCountScale1793900000000 implements MigrationInterface {
  name = 'WidenMonthsCountScale1793900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'revenue_items',
      'school_expense_items',
      'management_expense_items',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "monthsCount" TYPE numeric(15,4)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Làm tròn về 2 chữ số thập phân — mất phần lẻ đã nhập thêm.
    for (const table of [
      'revenue_items',
      'school_expense_items',
      'management_expense_items',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "monthsCount" TYPE numeric(15,2)`,
      );
    }
  }
}
