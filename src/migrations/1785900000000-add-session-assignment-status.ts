import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSessionAssignmentStatus1785900000000 implements MigrationInterface {
    name = 'AddSessionAssignmentStatus1785900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN
            CREATE TYPE "teaching_sessions_assignment_status_enum" AS ENUM
                ('OPEN', 'ASSIGNED', 'CLOSED', 'CANCELLED');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "assignment_status"
            "teaching_sessions_assignment_status_enum" NOT NULL DEFAULT 'ASSIGNED'`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ALTER COLUMN "teacher_id" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            DROP CONSTRAINT IF EXISTS "FK_teaching_sessions_teacher"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD CONSTRAINT "FK_teaching_sessions_teacher"
            FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE SET NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`UPDATE "teaching_sessions" SET "teacher_id" = (
            SELECT MIN("id") FROM "teachers"
        ) WHERE "teacher_id" IS NULL`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" ALTER COLUMN "teacher_id" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "assignment_status"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "teaching_sessions_assignment_status_enum"`);
    }
}
