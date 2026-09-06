import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSchoolLocations1790500000000 implements MigrationInterface {
    name = 'CreateSchoolLocations1790500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create school_locations table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "school_locations" (
                "id" SERIAL PRIMARY KEY,
                "school_id" integer NOT NULL,
                "name" character varying(150) NOT NULL,
                "address" character varying(500),
                "latitude" decimal(10,7),
                "longitude" decimal(10,7),
                "checkin_radius" integer,
                "google_maps_url" character varying(500),
                "ward_id" integer,
                "status" integer NOT NULL DEFAULT 1,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "FK_school_locations_school" FOREIGN KEY ("school_id")
                    REFERENCES "schools"("id") ON DELETE CASCADE,
                CONSTRAINT "FK_school_locations_ward" FOREIGN KEY ("ward_id")
                    REFERENCES "wards"("id") ON DELETE SET NULL
            )
        `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_school_locations_school_id" ON "school_locations" ("school_id")`
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_school_locations_school_name" ON "school_locations" ("school_id","name")`
        );

        // Add nullable school_location_id columns to related tables
        await queryRunner.query(
            `ALTER TABLE "school_classes" ADD COLUMN IF NOT EXISTS "school_location_id" integer`
        );
        await queryRunner.query(
            `ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "school_location_id" integer`
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" ADD COLUMN IF NOT EXISTS "school_location_id" integer`
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "school_location_id" integer`
        );

        // Add foreign key constraints
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "school_classes"
                ADD CONSTRAINT "FK_school_classes_location"
                FOREIGN KEY ("school_location_id") REFERENCES "school_locations"("id") ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "subjects"
                ADD CONSTRAINT "FK_subjects_location"
                FOREIGN KEY ("school_location_id") REFERENCES "school_locations"("id") ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "teaching_schedules"
                ADD CONSTRAINT "FK_teaching_schedules_location"
                FOREIGN KEY ("school_location_id") REFERENCES "school_locations"("id") ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "teaching_sessions"
                ADD CONSTRAINT "FK_teaching_sessions_location"
                FOREIGN KEY ("school_location_id") REFERENCES "school_locations"("id") ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        `);

        // Add indexes for the new columns
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_school_classes_school_location_id" ON "school_classes" ("school_location_id")`
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_subjects_school_location_id" ON "subjects" ("school_location_id")`
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_schedules_school_location_id" ON "teaching_schedules" ("school_location_id")`
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_school_location_id" ON "teaching_sessions" ("school_location_id")`
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_location_date" ON "teaching_sessions" ("school_location_id","date")`
        );

        // Chống trùng tên lớp: tách làm HAI partial unique index.
        //  - Lớp đã gắn điểm trường -> xét trùng trong phạm vi từng cơ sở, nên
        //    hai cơ sở của cùng một trường đều được có lớp "1A".
        //  - Lớp chưa gắn điểm trường -> giữ nguyên ràng buộc cũ theo trường.
        // Phải tách đôi vì Postgres coi mỗi NULL là khác nhau: một index 4 cột
        // thường sẽ cho tạo trùng "1A" nhiều lần ở các lớp chưa gắn cơ sở.
        // Dùng `WHERE` thay cho COALESCE để TypeORM hiểu được index này, nếu
        // không `synchronize: true` sẽ DROP mất ở lần khởi động kế tiếp.
        await queryRunner.query(
            `DROP INDEX IF EXISTS "UQ_school_classes_school_name_year"`
        );
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_school_classes_location_name_year"
            ON "school_classes" ("school_id", "school_location_id", "name", "school_year")
            WHERE "school_location_id" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_school_classes_school_name_year"
            ON "school_classes" ("school_id", "name", "school_year")
            WHERE "school_location_id" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Khôi phục unique index 3 cột nguyên bản (không partial).
        await queryRunner.query(
            `DROP INDEX IF EXISTS "UQ_school_classes_location_name_year"`
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "UQ_school_classes_school_name_year"`
        );
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS "UQ_school_classes_school_name_year"
            ON "school_classes" ("school_id", "name", "school_year")
        `);

        // Drop location-related indexes
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_teaching_sessions_location_date"`
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_teaching_sessions_school_location_id"`
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_teaching_schedules_school_location_id"`
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_subjects_school_location_id"`
        );
        await queryRunner.query(
            `DROP INDEX IF EXISTS "IDX_school_classes_school_location_id"`
        );

        // Drop foreign key constraints
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" DROP CONSTRAINT IF EXISTS "FK_teaching_sessions_location"`
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP CONSTRAINT IF EXISTS "FK_teaching_schedules_location"`
        );
        await queryRunner.query(
            `ALTER TABLE "subjects" DROP CONSTRAINT IF EXISTS "FK_subjects_location"`
        );
        await queryRunner.query(
            `ALTER TABLE "school_classes" DROP CONSTRAINT IF EXISTS "FK_school_classes_location"`
        );

        // Drop school_location_id columns
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "school_location_id"`
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "school_location_id"`
        );
        await queryRunner.query(
            `ALTER TABLE "subjects" DROP COLUMN IF EXISTS "school_location_id"`
        );
        await queryRunner.query(
            `ALTER TABLE "school_classes" DROP COLUMN IF EXISTS "school_location_id"`
        );

        // Drop school_locations table
        await queryRunner.query(`DROP TABLE IF EXISTS "school_locations"`);
    }
}
