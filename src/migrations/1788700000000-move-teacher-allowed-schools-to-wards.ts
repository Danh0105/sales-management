import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đổi cách phân trường cho giáo viên: từ chọn từng trường lẻ
 * (`teacher_allowed_schools`) sang chọn xã/phường (`teacher_allowed_wards`) —
 * giáo viên được **toàn bộ** trường thuộc xã/phường đã gán, tính động theo
 * `wards.schools` tại thời điểm tra cứu (không chốt cứng danh sách trường).
 *
 * Dữ liệu cũ: với mỗi (teacher_id, school_id) đã khai, suy ra ward_id của
 * trường đó rồi gán teacher vào ward tương ứng. Trường chưa gắn xã/phường
 * (`schools.ward_id IS NULL`) thì bỏ qua — không có ward để gán.
 *
 * Runtime chạy synchronize:true nên bảng mới được tạo tự động khi khởi động
 * lại; migration dành cho môi trường tắt synchronize.
 */
export class MoveTeacherAllowedSchoolsToWards1788700000000
  implements MigrationInterface
{
  name = 'MoveTeacherAllowedSchoolsToWards1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "teacher_allowed_wards" (
        "teacher_id" integer NOT NULL,
        "ward_id" integer NOT NULL,
        CONSTRAINT "PK_teacher_allowed_wards" PRIMARY KEY ("teacher_id", "ward_id"),
        CONSTRAINT "FK_teacher_allowed_wards_teacher" FOREIGN KEY ("teacher_id")
          REFERENCES "teachers"("id") ON UPDATE CASCADE ON DELETE CASCADE,
        CONSTRAINT "FK_teacher_allowed_wards_ward" FOREIGN KEY ("ward_id")
          REFERENCES "wards"("id") ON UPDATE CASCADE ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_teacher_allowed_wards_teacher" ON "teacher_allowed_wards" ("teacher_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_teacher_allowed_wards_ward" ON "teacher_allowed_wards" ("ward_id")`,
    );

    await queryRunner.query(`
      INSERT INTO "teacher_allowed_wards" ("teacher_id", "ward_id")
      SELECT DISTINCT tas."teacher_id", s."ward_id"
      FROM "teacher_allowed_schools" tas
      JOIN "schools" s ON s."id" = tas."school_id"
      WHERE s."ward_id" IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "teacher_allowed_wards"`);
  }
}
