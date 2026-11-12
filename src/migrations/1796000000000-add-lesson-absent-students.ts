import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Báo giảng: tổng sĩ số lớp + họ tên học sinh vắng (Mini App mới gửi kèm).
 * Sĩ số thực tế vẫn ở `actual_student_count` (= tổng − số vắng khi có tổng).
 * Hai cột nullable, dữ liệu cũ để NULL — không backfill.
 */
export class AddLessonAbsentStudents1796000000000 implements MigrationInterface {
  name = 'AddLessonAbsentStudents1796000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "total_student_count" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "absent_student_names" jsonb`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "absent_student_names"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "total_student_count"`,
    );
  }
}
