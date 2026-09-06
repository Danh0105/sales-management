import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeacherDefaultRatePerPeriod1788900000000 implements MigrationInterface {
  name = 'AddTeacherDefaultRatePerPeriod1788900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "default_rate_per_period" numeric(12,2)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "default_rate_per_period"`,
    );
  }
}
