import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quản lý lớp học cho phòng Nhân sự:
 * - school_classes: lớp của từng trường ("1A", "Lá 1") theo năm học.
 * - teaching_schedules.class_id / teaching_sessions.class_id: lịch dạy được xếp
 *   cho lớp thay vì cho cả trường.
 *
 * class_id để NULL được vì các lịch/buổi tạo trước khi có module lớp học chỉ
 * gắn tới trường; API mới bắt buộc classId khi tạo lịch.
 *
 * Runtime chạy synchronize:true nên bảng/cột được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class CreateSchoolClasses1786400000000 implements MigrationInterface {
    name = 'CreateSchoolClasses1786400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "school_classes" (
        "id" SERIAL PRIMARY KEY,
        "school_id" integer NOT NULL,
        "name" character varying(100) NOT NULL,
        "grade_level" smallint,
        "school_year" character varying(20) NOT NULL,
        "student_count" integer NOT NULL DEFAULT 0,
        "homeroom_teacher" character varying(255),
        "is_active" boolean NOT NULL DEFAULT true,
        "note" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_school_classes_school" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE CASCADE
      )
    `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_school_classes_school_id" ON "school_classes" ("school_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_school_classes_school_year" ON "school_classes" ("school_year")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_school_classes_is_active" ON "school_classes" ("is_active")`,
        );

        // Trong một trường + một năm học, tên lớp không trùng.
        await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_school_classes_school_name_year"
        ON "school_classes" ("school_id", "name", "school_year")
    `);

        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" ADD COLUMN IF NOT EXISTS "class_id" integer`,
        );
        await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "teaching_schedules"
          ADD CONSTRAINT "FK_teaching_schedules_class" FOREIGN KEY ("class_id")
          REFERENCES "school_classes"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_class_id" ON "teaching_schedules" ("class_id")`,
        );

        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "class_id" integer`,
        );
        await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "teaching_sessions"
          ADD CONSTRAINT "FK_teaching_sessions_class" FOREIGN KEY ("class_id")
          REFERENCES "school_classes"("id") ON DELETE CASCADE;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_class_id" ON "teaching_sessions" ("class_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_class_date" ON "teaching_sessions" ("class_id", "date")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" DROP CONSTRAINT IF EXISTS "FK_teaching_sessions_class"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "class_id"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP CONSTRAINT IF EXISTS "FK_teaching_schedules_class"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "class_id"`,
        );
        await queryRunner.query(`DROP TABLE IF EXISTS "school_classes"`);
    }
}
