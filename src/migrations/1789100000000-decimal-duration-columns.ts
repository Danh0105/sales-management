import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cho phép thời hạn lẻ (8.5 tháng, 3.4 tháng) ở các cột đang là `integer`.
 *
 * DTO vốn nhận `@IsNumber()` (chấp nhận số thập phân) nhưng cột lại là `int`,
 * nên giá trị lẻ lọt qua tầng kiểm tra rồi vỡ ở Postgres:
 * `invalid input syntax for type integer: "8.5"` → API trả 500, người dùng
 * không tạo được chính sách / môn học mà cũng không biết vì sao.
 *
 * Chuyển sang `numeric(6,2)` — số nguyên cũ vẫn giữ nguyên giá trị.
 *
 * Runtime chạy synchronize:true nên kiểu cột được đổi tự động khi khởi động
 * lại; migration dành cho môi trường tắt synchronize.
 */
export class DecimalDurationColumns1789100000000 implements MigrationInterface {
  name = 'DecimalDurationColumns1789100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "policy" ALTER COLUMN "duration_months" TYPE numeric(6,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "subjects" ALTER COLUMN "contract_years" TYPE numeric(6,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "subjects" ALTER COLUMN "appendix_years" TYPE numeric(6,2)`,
    );
  }

  /** Quay lại `int` sẽ LÀM TRÒN các giá trị lẻ đã lưu — không khôi phục được. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "policy" ALTER COLUMN "duration_months" TYPE integer USING ROUND("duration_months")`,
    );
    await queryRunner.query(
      `ALTER TABLE "subjects" ALTER COLUMN "contract_years" TYPE integer USING ROUND("contract_years")`,
    );
    await queryRunner.query(
      `ALTER TABLE "subjects" ALTER COLUMN "appendix_years" TYPE integer USING ROUND("appendix_years")`,
    );
  }
}
