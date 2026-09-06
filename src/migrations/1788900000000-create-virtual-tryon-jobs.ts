import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng job thử đồ ảo (Virtual Try-On): ảnh người + ảnh trang phục → ảnh kết
 * quả do mô hình sinh ảnh tạo ra.
 *
 * Chạy bất đồng bộ nên trạng thái nằm trong bảng chứ không phải trong RAM:
 * client tạo job rồi hỏi lại kết quả, và job dở dang khi restart vẫn truy ra
 * được để đánh dấu thất bại.
 *
 * Runtime chạy synchronize:true nên bảng được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class CreateVirtualTryonJobs1788900000000 implements MigrationInterface {
  name = 'CreateVirtualTryonJobs1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "virtual_tryon_jobs" (
        "id" SERIAL PRIMARY KEY,
        "status" varchar(20) NOT NULL DEFAULT 'PENDING',
        "person_image_url" varchar(500) NOT NULL,
        "garment_image_url" varchar(500) NOT NULL,
        "result_image_url" varchar(500) NULL,
        "prompt" text NOT NULL,
        "model" varchar(60) NOT NULL,
        "size" varchar(20) NOT NULL,
        "error_code" varchar(60) NULL,
        "error_message" text NULL,
        "input_tokens" integer NULL,
        "output_tokens" integer NULL,
        "duration_ms" integer NULL,
        "created_by" integer NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "finished_at" TIMESTAMP NULL,
        CONSTRAINT "FK_virtual_tryon_jobs_created_by" FOREIGN KEY ("created_by")
          REFERENCES "employee"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_virtual_tryon_jobs_status" ON "virtual_tryon_jobs" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_virtual_tryon_jobs_created_by" ON "virtual_tryon_jobs" ("created_by")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "virtual_tryon_jobs"`);
  }
}
