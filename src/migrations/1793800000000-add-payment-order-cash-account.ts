import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề xuất chi: "Nguồn chi" thủ quỹ chọn khi xác nhận xuất tiền (số hiệu tài
 * khoản trong danh mục Nguồn thu chi). Cột nullable, không default → chỉ đổi
 * metadata; lệnh chi cũ nhận NULL và vẫn giữ `fundSource` như trước.
 */
export class AddPaymentOrderCashAccount1793800000000 implements MigrationInterface {
  name = 'AddPaymentOrderCashAccount1793800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest_payment_order" ADD COLUMN IF NOT EXISTS "cashAccount" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest_payment_order" DROP COLUMN IF EXISTS "cashAccount"`,
    );
  }
}
