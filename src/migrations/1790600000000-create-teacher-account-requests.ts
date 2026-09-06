import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTeacherAccountRequests1790600000000
    implements MigrationInterface
{
    name = 'CreateTeacherAccountRequests1790600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHER_ACCOUNT_REQUEST'`,
        );
        await queryRunner.query(
            `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHER_ACCOUNT_RESULT'`,
        );

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teacher_account_requests" (
            "id" SERIAL NOT NULL,
            "payload" jsonb NOT NULL,
            "password_hash" varchar(100),
            "name" varchar(150) NOT NULL,
            "phone" varchar(20),
            "email" varchar(255),
            "teacher_id" integer,
            "requested_by" integer NOT NULL,
            "status" varchar(20) NOT NULL DEFAULT 'pending',
            "reviewed_by" integer,
            "review_note" varchar(500),
            "reviewed_at" timestamptz,
            "created_teacher_id" integer,
            "created_at" timestamptz NOT NULL DEFAULT now(),
            "updated_at" timestamptz NOT NULL DEFAULT now(),
            CONSTRAINT "PK_teacher_account_requests" PRIMARY KEY ("id"),
            CONSTRAINT "FK_teacher_account_requests_teacher" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE,
            CONSTRAINT "FK_teacher_account_requests_requester" FOREIGN KEY ("requested_by") REFERENCES "employee"("id") ON DELETE CASCADE,
            CONSTRAINT "FK_teacher_account_requests_reviewer" FOREIGN KEY ("reviewed_by") REFERENCES "employee"("id") ON DELETE SET NULL,
            CONSTRAINT "CHK_teacher_account_requests_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
        )`);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teacher_account_requests_status" ON "teacher_account_requests" ("status")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teacher_account_requests_requested_by" ON "teacher_account_requests" ("requested_by")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "teacher_account_requests"`,
        );
    }
}
