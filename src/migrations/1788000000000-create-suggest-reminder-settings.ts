import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lưu cấu hình nhắc hạn đề xuất chi khi môi trường triển khai tắt
 * TypeORM synchronize.
 */
export class CreateSuggestReminderSettings1788000000000
  implements MigrationInterface
{
  name = 'CreateSuggestReminderSettings1788000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "suggest_reminder_setting" (
        "id" SERIAL NOT NULL,
        "key" character varying NOT NULL,
        "value" character varying NOT NULL,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_suggest_reminder_setting_key" UNIQUE ("key"),
        CONSTRAINT "PK_suggest_reminder_setting" PRIMARY KEY ("id")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "suggest_reminder_setting"`,
    );
  }
}
