import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 19/11/2026: Thủ quỹ xuất tiền từ nhiều nguồn chi cho một đề xuất —
 * `suggest_payment_order."cashSplits"` = `[{ cashAccount, amount }]` (tổng = số
 * lệnh chi), null = một nguồn như cũ. Chỉ thêm cột nullable.
 */
export class AddPaymentOrderCashSplits1797300000000 implements MigrationInterface {
  name = 'AddPaymentOrderCashSplits1797300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest_payment_order" ADD COLUMN IF NOT EXISTS "cashSplits" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "suggest_payment_order" DROP COLUMN IF EXISTS "cashSplits"`);
  }
}
