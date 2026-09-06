import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeachingConfirmationStatus1787300000000 implements MigrationInterface {
    name = 'AddTeachingConfirmationStatus1787300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DO $$ BEGIN
            CREATE TYPE "teaching_schedules_confirmation_status_enum" AS ENUM
                ('PENDING', 'CONFIRMED', 'REJECTED');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await queryRunner.query(`DO $$ BEGIN
            CREATE TYPE "teaching_sessions_confirmation_status_enum" AS ENUM
                ('PENDING', 'CONFIRMED', 'REJECTED');
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

        await queryRunner.query(`ALTER TABLE "teaching_schedules"
            ADD COLUMN IF NOT EXISTS "confirmation_status"
            "teaching_schedules_confirmation_status_enum" NOT NULL DEFAULT 'PENDING'`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules"
            ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules"
            ADD COLUMN IF NOT EXISTS "rejection_reason" text`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules"
            ADD COLUMN IF NOT EXISTS "confirmation_alert_at" TIMESTAMP`);

        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "confirmation_status"
            "teaching_sessions_confirmation_status_enum" NOT NULL DEFAULT 'PENDING'`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "confirmed_at" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "rejection_reason" text`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions"
            ADD COLUMN IF NOT EXISTS "confirmation_alert_at" TIMESTAMP`);

        // Dữ liệu cũ (đã tồn tại trước tính năng này) coi như đã xác nhận —
        // không bắt giáo viên xác nhận ngược các lịch/buổi đã dạy hoặc đang chạy.
        await queryRunner.query(`UPDATE "teaching_schedules"
            SET "confirmation_status" = 'CONFIRMED', "confirmed_at" = "created_at"
            WHERE "created_at" < now()`);
        await queryRunner.query(`UPDATE "teaching_sessions"
            SET "confirmation_status" = 'CONFIRMED', "confirmed_at" = "created_at"
            WHERE "created_at" < now()`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "confirmation_alert_at"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "rejection_reason"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "confirmed_at"`);
        await queryRunner.query(`ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "confirmation_status"`);

        await queryRunner.query(`ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "confirmation_alert_at"`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "rejection_reason"`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "confirmed_at"`);
        await queryRunner.query(`ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "confirmation_status"`);

        await queryRunner.query(`DROP TYPE IF EXISTS "teaching_sessions_confirmation_status_enum"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "teaching_schedules_confirmation_status_enum"`);
    }
}
