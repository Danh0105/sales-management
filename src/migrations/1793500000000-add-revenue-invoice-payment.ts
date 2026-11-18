import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng Hóa Đơn: thêm "Ngày chi" và "Khoản thu/chi" (số hiệu tài khoản trong
 * danh mục Nguồn thu chi) cho từng dòng doanh thu. `IF NOT EXISTS` để chạy an
 * toàn cả khi synchronize đã tạo trước.
 */
export class AddRevenueInvoicePayment1793500000000
  implements MigrationInterface
{
  name = 'AddRevenueInvoicePayment1793500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoicePaymentDate" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoiceCashAccount" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoiceCashAccount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoicePaymentDate"`,
    );
  }
}
