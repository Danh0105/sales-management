import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng giờ tiết học theo TỪNG trường (Tiết 1 = 07:00–07:45...).
 *
 * Mỗi trường một khung giờ khác nhau nên không nhét được vào cột cố định trên
 * `schools`. Có bảng này thì xếp lịch chọn "Tiết 1–2" là tự ra giờ, thay vì gõ
 * tay và mặc định cứng 07:30–09:00 cho mọi trường như trước.
 *
 * Runtime chạy synchronize:true nên bảng được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class CreateSchoolPeriods1789000000000 implements MigrationInterface {
  name = 'CreateSchoolPeriods1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "school_periods" (
        "id" SERIAL PRIMARY KEY,
        "school_id" integer NOT NULL,
        "period_no" integer NOT NULL,
        "start_time" time NOT NULL,
        "end_time" time NOT NULL,
        "label" varchar(100) NULL,
        "session" varchar(10) NOT NULL DEFAULT 'SANG',
        "is_period" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_school_periods_school" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE CASCADE
      )
    `);

    // Một trường không thể có hai "Tiết 1" — chặn ở DB chứ không chỉ ở service.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_school_periods_school_period"
       ON "school_periods" ("school_id", "period_no")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "school_periods"`);
  }
}
