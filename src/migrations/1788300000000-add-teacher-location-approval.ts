import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeacherLocationApproval1788300000000 implements MigrationInterface {
  name = 'AddTeacherLocationApproval1788300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHER_LOCATION_CHANGE_REQUEST'`,
    );
    await queryRunner.query(
      `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHER_LOCATION_CHANGE_RESULT'`,
    );
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teacher_location_changes" (
      "id" SERIAL NOT NULL,
      "teacher_id" integer NOT NULL,
      "latitude" numeric(10,7) NOT NULL,
      "longitude" numeric(10,7) NOT NULL,
      "previous_latitude" numeric(10,7),
      "previous_longitude" numeric(10,7),
      "status" varchar(20) NOT NULL DEFAULT 'pending',
      "reviewed_by" integer,
      "review_note" varchar(500),
      "reviewed_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_teacher_location_changes" PRIMARY KEY ("id"),
      CONSTRAINT "FK_teacher_location_changes_teacher" FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_teacher_location_changes_reviewer" FOREIGN KEY ("reviewed_by") REFERENCES "employee"("id") ON DELETE SET NULL,
      CONSTRAINT "CHK_teacher_location_changes_status" CHECK ("status" IN ('pending', 'approved', 'rejected'))
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_teacher_location_changes_teacher_status" ON "teacher_location_changes" ("teacher_id", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_teacher_location_changes_pending" ON "teacher_location_changes" ("teacher_id") WHERE "status" = 'pending'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "teacher_location_changes"`);
  }
}
