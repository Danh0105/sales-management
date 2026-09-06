import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeachingScheduleNotificationLogs1786200000000 implements MigrationInterface {
    name = 'AddTeachingScheduleNotificationLogs1786200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teaching_schedule_notification_logs" (
            "id" SERIAL NOT NULL,
            "sender_id" integer NOT NULL,
            "from_date" date NOT NULL,
            "to_date" date NOT NULL,
            "signature" character varying(255) NOT NULL,
            "filters" jsonb NOT NULL,
            "notified_count" integer NOT NULL DEFAULT 0,
            "session_count" integer NOT NULL DEFAULT 0,
            "skipped_without_account" integer NOT NULL DEFAULT 0,
            "email_sent_count" integer NOT NULL DEFAULT 0,
            "created_at" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_teaching_schedule_notification_logs" PRIMARY KEY ("id")
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_teaching_notify_signature_created"
            ON "teaching_schedule_notification_logs" ("signature", "created_at")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "teaching_schedule_notification_logs"`);
    }
}
