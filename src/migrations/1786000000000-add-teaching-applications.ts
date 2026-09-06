import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeachingApplications1786000000000 implements MigrationInterface {
    name = 'AddTeachingApplications1786000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teachers"
            ADD COLUMN IF NOT EXISTS "max_periods_per_week" integer`);
        await queryRunner.query(`DO $$ BEGIN
            CREATE TYPE "teaching_session_applications_status_enum" AS ENUM
                ('PENDING', 'SELECTED', 'NOT_SELECTED', 'WITHDRAWN');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teaching_session_applications" (
            "id" SERIAL PRIMARY KEY,
            "session_id" integer NOT NULL,
            "teacher_id" integer NOT NULL,
            "status" "teaching_session_applications_status_enum" NOT NULL DEFAULT 'PENDING',
            "latitude" decimal(10,7) NOT NULL,
            "longitude" decimal(10,7) NOT NULL,
            "accuracy" integer,
            "distance" integer,
            "note" text,
            "created_at" timestamp NOT NULL DEFAULT now(),
            "updated_at" timestamp NOT NULL DEFAULT now(),
            CONSTRAINT "FK_teaching_applications_session" FOREIGN KEY ("session_id")
                REFERENCES "teaching_sessions"("id") ON DELETE CASCADE,
            CONSTRAINT "FK_teaching_applications_teacher" FOREIGN KEY ("teacher_id")
                REFERENCES "teachers"("id") ON DELETE CASCADE,
            CONSTRAINT "UQ_teaching_applications_session_teacher" UNIQUE ("session_id", "teacher_id")
        )`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "teaching_session_applications"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "teaching_session_applications_status_enum"`);
        await queryRunner.query(`ALTER TABLE "teachers" DROP COLUMN IF EXISTS "max_periods_per_week"`);
    }
}
