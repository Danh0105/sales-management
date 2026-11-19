import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 19/11/2026: Thuế TNCN bảng Giáo viên trường sửa tay được (`pit_manual`) và
 * "Tổng thanh toán công ty" của bảng Hóa Đơn nhập tay được
 * (`revenue_items.companyPaymentTotal`, null = tự tính). Chỉ thêm cột, không đổi
 * dữ liệu; bản cũ chạy được trên schema mới.
 */
export class AddPitManualCompanyPayment1797200000000 implements MigrationInterface {
  name = 'AddPitManualCompanyPayment1797200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "school_teacher_expense_items" ADD COLUMN IF NOT EXISTS "pit_manual" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "companyPaymentTotal" numeric(15,2)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "companyPaymentTotal"`);
    await queryRunner.query(
      `ALTER TABLE "school_teacher_expense_items" DROP COLUMN IF EXISTS "pit_manual"`,
    );
  }
}
