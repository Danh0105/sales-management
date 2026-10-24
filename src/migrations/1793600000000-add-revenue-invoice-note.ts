import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng Hóa Đơn: lưu cột "Ghi chú" của từng dòng doanh thu. Cột nullable, không
 * default → chỉ đổi metadata, không ghi lại dữ liệu; bản ghi cũ nhận NULL.
 * `IF NOT EXISTS` để chạy an toàn cả khi synchronize đã tạo trước.
 */
export class AddRevenueInvoiceNote1793600000000 implements MigrationInterface {
  name = 'AddRevenueInvoiceNote1793600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoiceNote" character varying(500)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoiceNote"`,
    );
  }
}
