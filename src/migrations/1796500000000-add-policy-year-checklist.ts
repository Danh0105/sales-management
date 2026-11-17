import { MigrationInterface, QueryRunner } from 'typeorm';

/** Ba checklist theo từng biên bản chính sách trường + năm học. */
export class AddPolicyYearChecklist1796500000000 implements MigrationInterface {
  name = 'AddPolicyYearChecklist1796500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "policy_years"
      ADD COLUMN IF NOT EXISTS "gift_flowers_completed" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "opening_ceremony_completed" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "teachers_day_completed" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "policy_years"
      DROP COLUMN IF EXISTS "teachers_day_completed",
      DROP COLUMN IF EXISTS "opening_ceremony_completed",
      DROP COLUMN IF EXISTS "gift_flowers_completed"
    `);
  }
}
