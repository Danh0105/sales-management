import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Danh mục môn học (sales admin tạo) + liên kết từ môn học của trường.
 *
 * Dữ liệu cũ được giữ nguyên: mọi tên môn đã có trong bảng `subjects` được
 * gom (bỏ khoảng trắng thừa, không phân biệt hoa/thường) và nạp vào danh mục,
 * sau đó `subjects.catalog_id` được map lại theo tên.
 */
export class CreateSubjectCatalog1786300000000 implements MigrationInterface {
    name = 'CreateSubjectCatalog1786300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE IF NOT EXISTS "subject_catalogs" (
            "id" SERIAL NOT NULL,
            "name" character varying(255) NOT NULL,
            "code" character varying(50),
            "description" text,
            "is_active" boolean NOT NULL DEFAULT true,
            "sort_order" integer NOT NULL DEFAULT 0,
            "created_at" TIMESTAMP NOT NULL DEFAULT now(),
            "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
            CONSTRAINT "PK_subject_catalogs" PRIMARY KEY ("id")
        )`);

        await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subject_catalogs_name"
            ON "subject_catalogs" ("name")`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subject_catalogs_is_active"
            ON "subject_catalogs" ("is_active")`);

        await queryRunner.query(`ALTER TABLE "subjects"
            ADD COLUMN IF NOT EXISTS "catalog_id" integer`);
        await queryRunner.query(`DO $$ BEGIN
            ALTER TABLE "subjects"
                ADD CONSTRAINT "FK_subjects_catalog"
                FOREIGN KEY ("catalog_id") REFERENCES "subject_catalogs"("id")
                ON DELETE SET NULL;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END $$`);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_subjects_catalog_id"
            ON "subjects" ("catalog_id")`);

        // Nạp danh mục từ các môn học đã tạo trước đây.
        // Các biến thể chỉ khác hoa/thường hoặc khoảng trắng được gom về một
        // dòng: lấy cách viết được dùng nhiều nhất làm tên chuẩn.
        await queryRunner.query(`WITH cleaned AS (
                SELECT btrim(regexp_replace("name", '\\s+', ' ', 'g')) AS clean_name,
                       COUNT(*) AS uses
                FROM "subjects"
                WHERE "name" IS NOT NULL
                  AND btrim("name") <> ''
                GROUP BY 1
            ),
            canonical AS (
                SELECT DISTINCT ON (LOWER(clean_name))
                       clean_name
                FROM cleaned
                ORDER BY LOWER(clean_name), uses DESC, clean_name ASC
            )
            INSERT INTO "subject_catalogs" ("name", "is_active", "sort_order")
            SELECT canonical.clean_name, true, 0
            FROM canonical
            WHERE NOT EXISTS (
                SELECT 1 FROM "subject_catalogs" existing
                WHERE LOWER(existing."name") = LOWER(canonical.clean_name)
            )`);

        await queryRunner.query(`UPDATE "subjects" AS subject
            SET "catalog_id" = catalog."id"
            FROM "subject_catalogs" AS catalog
            WHERE subject."catalog_id" IS NULL
              AND LOWER(btrim(regexp_replace(subject."name", '\\s+', ' ', 'g')))
                  = LOWER(catalog."name")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subjects_catalog_id"`);
        await queryRunner.query(`ALTER TABLE "subjects"
            DROP CONSTRAINT IF EXISTS "FK_subjects_catalog"`);
        await queryRunner.query(`ALTER TABLE "subjects"
            DROP COLUMN IF EXISTS "catalog_id"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "subject_catalogs"`);
    }
}
