import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phụ cấp xăng theo khoảng cách cho giáo viên công ty — thay cho tiền theo
 * tiết (chỉ áp dụng buổi tạo mới, không tính lại buổi cũ):
 * - Bảng `fuel_allowance_tiers`: bậc thang km -> số tiền, Nhân sự khai.
 * - `teaching_sessions.distance_to_school_km` / `gas_allowance`: chốt tại
 *   thời điểm tạo buổi, giống cơ chế chốt `rate_per_period`.
 *
 * Runtime chạy synchronize:true nên schema được tạo tự động khi khởi động
 * lại; migration dành cho môi trường tắt synchronize.
 */
export class AddFuelAllowance1788600000000 implements MigrationInterface {
  name = 'AddFuelAllowance1788600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "fuel_allowance_tiers" (
        "id" SERIAL PRIMARY KEY,
        "min_distance_km" numeric(6,2) NOT NULL,
        "max_distance_km" numeric(6,2) NULL,
        "amount" numeric(15,2) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "distance_to_school_km" numeric(6,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "gas_allowance" numeric(15,2) NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "gas_allowance"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "distance_to_school_km"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "fuel_allowance_tiers"`);
  }
}
