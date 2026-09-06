import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cho phép giáo viên từ chối buổi đã được phân công (việc đột xuất) —
 * gỡ teacherId, mở lại buổi để Nhân sự chọn người thay thế, giữ lại
 * thông tin người vừa từ chối làm lịch sử.
 *
 * Runtime chạy synchronize:true nên cột được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class AddDeclineToTeachingSession1788200000000
  implements MigrationInterface
{
  name = 'AddDeclineToTeachingSession1788200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "declined_at" timestamp NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "decline_reason" text NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "declined_teacher_id" int NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD CONSTRAINT "FK_teaching_sessions_declined_teacher" ` +
        `FOREIGN KEY ("declined_teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP CONSTRAINT IF EXISTS "FK_teaching_sessions_declined_teacher"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "declined_teacher_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "decline_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "declined_at"`,
    );
  }
}
