import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề xuất chi tháng chọn được nhiều trường: mỗi dòng là trường + năm học +
 * môn + kỳ kế toán. Chỉ tạo bảng mới, không đổi bảng/dữ liệu cũ; đề xuất cũ
 * không có dòng nào thì đọc từ các cột của `suggest` như trước.
 * Tên khoá theo tên TypeORM tự sinh để schema builder không đòi đổi tên.
 */
export class AddSuggestMonthlyItems1795500000000 implements MigrationInterface {
  name = 'AddSuggestMonthlyItems1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "suggest_monthly_items" (
        "id" SERIAL NOT NULL,
        "suggest_id" integer NOT NULL,
        "school_id" integer,
        "school_year" character varying(20),
        "subject_id" integer,
        "expense_period_id" integer,
        "position" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_e079c18e107833b7afde639354d" PRIMARY KEY ("id"),
        CONSTRAINT "FK_3dfeac7049881d1aae38a109e08" FOREIGN KEY ("suggest_id")
          REFERENCES "suggest"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_0c58e17a0d135812bffa5d98478" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_edb43eb088e83c77e7e71501217" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_3430059431bb2f61c6935ab6298" FOREIGN KEY ("expense_period_id")
          REFERENCES "expense_periods"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_suggest_monthly_items_suggest"
      ON "suggest_monthly_items" ("suggest_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_suggest_monthly_items_school"
      ON "suggest_monthly_items" ("school_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "suggest_monthly_items"`);
  }
}
