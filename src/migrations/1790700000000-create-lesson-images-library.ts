import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLessonImagesLibrary1790700000000 implements MigrationInterface {
  name = 'CreateLessonImagesLibrary1790700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "lesson_images" (
        "id" SERIAL NOT NULL,
        "session_id" integer NOT NULL,
        "url" varchar(500) NOT NULL,
        "thumbnail_url" varchar(500),
        "mime_type" varchar(100),
        "sort_order" integer NOT NULL DEFAULT 0,
        "type" varchar(50) NOT NULL DEFAULT 'LESSON_REPORT',
        "created_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lesson_images" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lesson_images_session" FOREIGN KEY ("session_id")
          REFERENCES "teaching_sessions"("id") ON DELETE CASCADE
      )
    `);

    // Backfill every legacy JSON item without modifying the JSON or original URL.
    // Video evidence is intentionally omitted: this endpoint is an image library.
    await queryRunner.query(`
      INSERT INTO "lesson_images"
        ("session_id", "url", "thumbnail_url", "mime_type", "sort_order", "created_at")
      SELECT
        ss.id,
        image.item->>'url',
        CASE
          WHEN image.item->>'url' ~ '^/uploads/lesson-images/[0-9a-f-]{36}\\.(webp|jpg|jpeg|png)$'
          THEN regexp_replace(image.item->>'url', '^/uploads/lesson-images/(.*)\\.[^.]+$', '/uploads/lesson-images/thumb/\\1.webp')
          ELSE NULL
        END,
        image.item->>'mimeType',
        COALESCE(NULLIF(image.item->>'sortOrder', '')::integer, image.ordinality::integer - 1),
        COALESCE(ss.lesson_submitted_at, ss.checkout_at, ss.created_at)
      FROM teaching_sessions ss
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ss.lesson_images, '[]'::jsonb))
        WITH ORDINALITY AS image(item, ordinality)
      WHERE image.item ? 'url'
        AND COALESCE(image.item->>'mimeType', '') NOT LIKE 'video/%'
        AND (image.item->>'url') !~* '\\.(mp4|mov|webm)$'
        AND NOT EXISTS (
          SELECT 1 FROM lesson_images li
          WHERE li.session_id = ss.id
            AND li.sort_order = COALESCE(NULLIF(image.item->>'sortOrder', '')::integer, image.ordinality::integer - 1)
        )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_lesson_images_session_id" ON "lesson_images" ("session_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_lesson_images_created_at_id" ON "lesson_images" ("created_at" DESC, "id" DESC)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lesson_images_session_sort_order" ON "lesson_images" ("session_id", "sort_order")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_teaching_sessions_library_filters" ON "teaching_sessions" ("teacher_id", "school_id", "date", "status")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_teaching_sessions_library_filters"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lesson_images"`);
  }
}
