import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cho phép tắt nhắc quá hạn riêng cho từng đề xuất chi — không đụng tới cron
 * nhắc chung, chỉ bỏ qua đúng bản ghi đã tắt.
 *
 * Runtime chạy synchronize:true nên cột được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class AddOverdueAlertMutedToSuggest1788100000000
  implements MigrationInterface
{
  name = 'AddOverdueAlertMutedToSuggest1788100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "overdue_alert_muted" boolean NOT NULL DEFAULT false`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "overdue_alert_muted"`,
    );
  }
}
