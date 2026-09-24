import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cờ "Trừ chính sách" do kinh doanh tự chọn khi tạo/sửa đề xuất chi — chỉ để
 * hiển thị/thống kê, không có logic trừ tiền tự động kèm theo.
 */
export class AddSuggestDeductPolicy1791200000000 implements MigrationInterface {
  name = 'AddSuggestDeductPolicy1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "suggest"
      ADD COLUMN IF NOT EXISTS "deduct_policy" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "suggest" DROP COLUMN IF EXISTS "deduct_policy"
    `);
  }
}
