import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Module giảng dạy cho phòng Nhân sự (role `nhansu`) và giáo viên (role `giaovien`):
 * - teachers: hồ sơ giáo viên, employee_id gắn tài khoản khi là giáo viên cơ hữu.
 * - teaching_schedules: mẫu lịch lặp theo tuần.
 * - teaching_sessions: buổi dạy cụ thể + trạng thái chấm công.
 *
 * Runtime chạy synchronize:true nên bảng được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class CreateTeachingModule1785500000000 implements MigrationInterface {
    name = 'CreateTeachingModule1785500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "teachers" (
        "id" SERIAL PRIMARY KEY,
        "name" character varying NOT NULL,
        "phone" character varying(20),
        "email" character varying,
        "employee_id" integer,
        "is_active" boolean NOT NULL DEFAULT true,
        "note" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_teachers_phone" UNIQUE ("phone"),
        CONSTRAINT "UQ_teachers_employee_id" UNIQUE ("employee_id"),
        CONSTRAINT "FK_teachers_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employee"("id") ON DELETE SET NULL
      )
    `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teachers_is_active" ON "teachers" ("is_active")`,
        );

        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "teaching_schedules" (
        "id" SERIAL PRIMARY KEY,
        "teacher_id" integer NOT NULL,
        "school_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "day_of_week" smallint NOT NULL,
        "start_time" TIME NOT NULL,
        "end_time" TIME NOT NULL,
        "effective_from" date NOT NULL,
        "effective_to" date,
        "is_active" boolean NOT NULL DEFAULT true,
        "note" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_teaching_schedules_teacher" FOREIGN KEY ("teacher_id")
          REFERENCES "teachers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_schedules_school" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_schedules_subject" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE CASCADE
      )
    `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_teacher_id" ON "teaching_schedules" ("teacher_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_school_id" ON "teaching_schedules" ("school_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_subject_id" ON "teaching_schedules" ("subject_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_teacher_day" ON "teaching_schedules" ("teacher_id", "day_of_week")`,
        );

        await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "teaching_sessions_status_enum" AS ENUM
          ('SCHEDULED', 'PRESENT', 'ABSENT', 'EXCUSED', 'CANCELLED');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);

        await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "teaching_sessions" (
        "id" SERIAL PRIMARY KEY,
        "schedule_id" integer,
        "teacher_id" integer NOT NULL,
        "school_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "date" date NOT NULL,
        "start_time" TIME NOT NULL,
        "end_time" TIME NOT NULL,
        "status" "teaching_sessions_status_enum" NOT NULL DEFAULT 'SCHEDULED',
        "is_makeup" boolean NOT NULL DEFAULT false,
        "makeup_for_session_id" integer,
        "attendance_note" text,
        "checked_by_id" integer,
        "checked_at" TIMESTAMP,
        "note" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "FK_teaching_sessions_schedule" FOREIGN KEY ("schedule_id")
          REFERENCES "teaching_schedules"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_sessions_teacher" FOREIGN KEY ("teacher_id")
          REFERENCES "teachers"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_sessions_school" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_sessions_subject" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teaching_sessions_makeup_for" FOREIGN KEY ("makeup_for_session_id")
          REFERENCES "teaching_sessions"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_teaching_sessions_checked_by" FOREIGN KEY ("checked_by_id")
          REFERENCES "employee"("id") ON DELETE SET NULL
      )
    `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_date" ON "teaching_sessions" ("date")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_teacher_date" ON "teaching_sessions" ("teacher_id", "date")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_status_date" ON "teaching_sessions" ("status", "date")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_school_id" ON "teaching_sessions" ("school_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_subject_id" ON "teaching_sessions" ("subject_id")`,
        );

        // Một mẫu lặp chỉ sinh đúng 1 buổi cho mỗi ngày -> sinh lại không nhân đôi.
        await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teaching_sessions_schedule_date"
        ON "teaching_sessions" ("schedule_id", "date")
        WHERE "schedule_id" IS NOT NULL
    `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "teaching_sessions"`);
        await queryRunner.query(
            `DROP TYPE IF EXISTS "teaching_sessions_status_enum"`,
        );
        await queryRunner.query(`DROP TABLE IF EXISTS "teaching_schedules"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "teachers"`);
    }
}
