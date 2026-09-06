import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRecommendedTeacher1786100000000 implements MigrationInterface {
    name = 'AddRecommendedTeacher1786100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "recommended_teacher_id" integer`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "teaching_sessions"
                ADD CONSTRAINT "FK_teaching_sessions_recommended_teacher"
                FOREIGN KEY ("recommended_teacher_id") REFERENCES "teachers"("id")
                ON DELETE SET NULL;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$`);
        await queryRunner.query(`UPDATE "teaching_sessions" AS session
            SET "recommended_teacher_id" = (
                SELECT application."teacher_id"
                FROM "teaching_session_applications" AS application
                INNER JOIN "teachers" AS teacher
                    ON teacher."id" = application."teacher_id"
                WHERE application."session_id" = session."id"
                  AND application."status" = 'PENDING'
                  AND teacher."is_active" = true
                ORDER BY application."distance" ASC NULLS LAST,
                         application."created_at" ASC
                LIMIT 1
            )
            WHERE session."assignment_status" = 'OPEN'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            DROP CONSTRAINT IF EXISTS "FK_teaching_sessions_recommended_teacher"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            DROP COLUMN IF EXISTS "recommended_teacher_id"`);
    }
}
