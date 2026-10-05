import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Tài liệu HR riêng tư (Task 0.4C).
 *
 * - `hr.files`: CHỈ metadata — nội dung nằm ở kho riêng (`storage_key` ngẫu
 *   nhiên, không lưu URL công khai, không lưu đường dẫn tuyệt đối). Không xoá
 *   dòng: lưu trữ = `status = ARCHIVED`; `deleted_at` dành cho lifecycle xoá
 *   vật lý sau này. Mỗi giấy tờ tuỳ thân có tối đa 1 file ACTIVE cho mỗi mặt.
 * - `hr.file_access_tokens`: token truy cập nội dung có hạn cho adapter không
 *   có signed URL. Chỉ lưu SHA-256 của token (token 256 bit ngẫu nhiên).
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới trong schema hr, không đụng bảng cũ.
 * Rollback: `down()` từ chối nếu đã có dữ liệu (file thật nằm ngoài DB — phải
 * xử lý kho riêng trước).
 */
export class HrCreatePrivateFiles1791700000500 implements MigrationInterface {
  name = 'HrCreatePrivateFiles1791700000500';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."files" (
        "id" SERIAL NOT NULL,
        "storage_key" varchar(64) NOT NULL,
        "original_name" varchar(255) NOT NULL,
        "mime_type" varchar(100) NOT NULL,
        "size_bytes" integer NOT NULL,
        "sha256" char(64) NOT NULL,
        "classification" varchar(16) NOT NULL,
        "document_type" varchar(32) NOT NULL,
        "owner_employee_id" integer NOT NULL,
        "identity_document_id" integer,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "scan_status" varchar(16) NOT NULL DEFAULT 'NOT_SCANNED',
        "uploaded_by" integer,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "archived_at" timestamptz,
        "archived_by" integer,
        "archive_reason" text,
        "deleted_at" timestamptz,
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_hr_files" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_files_owner" FOREIGN KEY ("owner_employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_files_identity_document" FOREIGN KEY ("identity_document_id")
          REFERENCES "hr"."employee_identity_documents"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_files_storage_key"
          CHECK ("storage_key" ~ '^[0-9a-f]{2}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
        CONSTRAINT "CHK_hr_files_mime"
          CHECK ("mime_type" IN ('application/pdf','image/jpeg','image/png')),
        CONSTRAINT "CHK_hr_files_size" CHECK ("size_bytes" > 0),
        CONSTRAINT "CHK_hr_files_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_hr_files_classification"
          CHECK ("classification" IN ('INTERNAL','CONFIDENTIAL','RESTRICTED')),
        CONSTRAINT "CHK_hr_files_document_type"
          CHECK ("document_type" IN ('IDENTITY_FRONT','IDENTITY_BACK','BANK_PROOF','CONTRACT','TAX','INSURANCE','GENERAL')),
        CONSTRAINT "CHK_hr_files_identity_relation"
          CHECK (("document_type" IN ('IDENTITY_FRONT','IDENTITY_BACK')) = ("identity_document_id" IS NOT NULL)),
        CONSTRAINT "CHK_hr_files_status" CHECK ("status" IN ('ACTIVE','ARCHIVED','DELETED')),
        CONSTRAINT "CHK_hr_files_scan_status"
          CHECK ("scan_status" IN ('PENDING','CLEAN','INFECTED','FAILED','NOT_SCANNED')),
        CONSTRAINT "CHK_hr_files_archived"
          CHECK (("status" = 'ACTIVE') = ("archived_at" IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_files_storage_key"
        ON "hr"."files" ("storage_key")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_files_identity_side_active"
        ON "hr"."files" ("identity_document_id", "document_type")
        WHERE "status" = 'ACTIVE' AND "identity_document_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_hr_files_owner"
        ON "hr"."files" ("owner_employee_id")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."file_access_tokens" (
        "id" SERIAL NOT NULL,
        "file_id" integer NOT NULL,
        "token_hash" char(64) NOT NULL,
        "account_id" integer NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_hr_file_access_tokens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_file_access_tokens_file" FOREIGN KEY ("file_id")
          REFERENCES "hr"."files"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_file_access_tokens_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_hr_file_access_tokens_expiry" CHECK ("expires_at" > "created_at")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_hr_file_access_tokens_hash"
        ON "hr"."file_access_tokens" ("token_hash")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['file_access_tokens', 'files']) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF to_regclass('"hr"."${table}"') IS NOT NULL
             AND EXISTS (SELECT 1 FROM "hr"."${table}") THEN
            RAISE EXCEPTION 'hr.${table} có dữ liệu — rollback tay sau khi backup';
          END IF;
        END $$
      `);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."file_access_tokens"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."files"`);
  }
}
