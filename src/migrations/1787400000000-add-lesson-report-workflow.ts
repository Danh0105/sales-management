import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLessonReportWorkflow1787400000000 implements MigrationInterface {
  name = 'AddLessonReportWorkflow1787400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHING_LESSON_REPORT_ALERT'`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkin_images" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "actual_student_count" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "lesson_submitted_at" timestamp`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "lesson_report_alert_at" timestamp`,
    );
    // Dữ liệu cũ chỉ có nội dung bài khi checkout; đánh dấu đã báo giảng để
    // không phát cảnh báo ngược cho lịch sử.
    await queryRunner.query(
      `UPDATE "teaching_sessions" SET "lesson_submitted_at" = "checkout_at" WHERE "lesson_name" IS NOT NULL AND "lesson_submitted_at" IS NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkin_images"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "lesson_report_alert_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "lesson_submitted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "actual_student_count"`,
    );
  }
}
