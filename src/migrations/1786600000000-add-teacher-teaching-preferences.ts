import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phạm vi/năng lực nhận dạy của giáo viên phục vụ gợi ý lịch:
 * - vị trí Google Maps của giáo viên;
 * - nhiều trường có thể nhận dạy;
 * - nhiều môn theo danh mục môn dùng chung.
 *
 * Runtime hiện chạy synchronize:true; migration này dành cho môi trường tắt
 * synchronize và giúp việc triển khai schema có thể kiểm soát rõ ràng.
 */
export class AddTeacherTeachingPreferences1786600000000
    implements MigrationInterface
{
    name = 'AddTeacherTeachingPreferences1786600000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "google_maps_url" varchar(500)`,
        );

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teacher_allowed_schools" (
            "teacher_id" integer NOT NULL,
            "school_id" integer NOT NULL,
            CONSTRAINT "PK_teacher_allowed_schools" PRIMARY KEY ("teacher_id", "school_id")
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_teacher_allowed_schools_school"
            ON "teacher_allowed_schools" ("school_id")`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "teacher_allowed_schools"
                ADD CONSTRAINT "FK_teacher_allowed_schools_teacher"
                FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "teacher_allowed_schools"
                ADD CONSTRAINT "FK_teacher_allowed_schools_school"
                FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "teacher_subject_catalogs" (
            "teacher_id" integer NOT NULL,
            "subject_catalog_id" integer NOT NULL,
            CONSTRAINT "PK_teacher_subject_catalogs" PRIMARY KEY ("teacher_id", "subject_catalog_id")
        )`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_teacher_subject_catalogs_subject"
            ON "teacher_subject_catalogs" ("subject_catalog_id")`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "teacher_subject_catalogs"
                ADD CONSTRAINT "FK_teacher_subject_catalogs_teacher"
                FOREIGN KEY ("teacher_id") REFERENCES "teachers"("id") ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "teacher_subject_catalogs"
                ADD CONSTRAINT "FK_teacher_subject_catalogs_subject"
                FOREIGN KEY ("subject_catalog_id") REFERENCES "subject_catalogs"("id") ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "teacher_subject_catalogs"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "teacher_allowed_schools"`);
        await queryRunner.query(
            `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "google_maps_url"`,
        );
    }
}
