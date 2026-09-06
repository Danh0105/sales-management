import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cho phép check-out từng tiết trong một block nhiều tiết liên tiếp cùng
 * trường (không chỉ tiết cuối) — cột này đánh dấu tiết nào tự check-out thật
 * (giáo viên bấm) và tiết nào chỉ "ăn theo" check-out của tiết cuối block.
 *
 * Runtime chạy synchronize:true nên cột được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class AddCheckoutViaAdjacentToTeachingSession1788500000000
  implements MigrationInterface
{
  name = 'AddCheckoutViaAdjacentToTeachingSession1788500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "checkout_via_adjacent" boolean DEFAULT false`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "checkout_via_adjacent"`,
    );
  }
}
