import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCheckoutLessonContent1786800000000 implements MigrationInterface {
  name = 'AddCheckoutLessonContent1786800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "lesson_name" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "lesson_evaluation" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "lesson_images" jsonb`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "lesson_images"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "lesson_evaluation"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "lesson_name"`,
    );
  }
}
