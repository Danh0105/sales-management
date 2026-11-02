import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Hồ sơ tài liệu nhân viên (Phase 1.3) — dùng lại Private Files 0.4C: mỗi phiên
 * bản tài liệu là MỘT dòng `hr.files` (kho, token tải, audit FILE_* giữ nguyên).
 *
 * - `employee_documents`: tài liệu nghiệp vụ (loại, tiêu đề, nơi cấp, ngày
 *   cấp/hết hạn, ghi chú, trạng thái). KHÔNG lưu số hiệu giấy tờ.
 * - `employee_document_versions`: lịch sử phiên bản → file. File của phiên bản
 *   cũ vẫn ACTIVE (xem lại được); phiên bản hiện hành = `current_version_id`.
 * - Quyền: DOCUMENT_VIEW, DOCUMENT_MANAGE (HR_OFFICER + role cũ nhansu ở
 *   COMPANY); HEALTH_DOCUMENT_VIEW nhạy cảm — KHÔNG gán cho role nào.
 *
 * Rủi ro: SAFE — chỉ tạo bảng mới và thêm quyền trong schema hr.
 * Rollback: `down()` từ chối nếu có dữ liệu hoặc quyền mới đã được cấp lẻ.
 */
export class HrEmployeeDocuments1791700001100 implements MigrationInterface {
  name = 'HrEmployeeDocuments1791700001100';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_documents" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "document_type" varchar(32) NOT NULL,
        "title" varchar(200) NOT NULL,
        "issuer" varchar(200),
        "issued_on" date,
        "expires_on" date,
        "note" text,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "current_version_id" integer,
        "version" integer NOT NULL DEFAULT 1,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "updated_by" integer,
        "archived_at" timestamptz,
        "archived_by" integer,
        "archive_reason" text,
        CONSTRAINT "PK_hr_employee_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_employee_documents_employee" FOREIGN KEY ("employee_id")
          REFERENCES "hr"."employees"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_hr_employee_documents_type"
          CHECK ("document_type" IN ('RESUME','DEGREE','CERTIFICATE','HEALTH_CERTIFICATE','OTHER')),
        CONSTRAINT "CHK_hr_employee_documents_title" CHECK (length(trim("title")) > 0),
        CONSTRAINT "CHK_hr_employee_documents_status" CHECK ("status" IN ('ACTIVE','ARCHIVED')),
        CONSTRAINT "CHK_hr_employee_documents_dates"
          CHECK ("issued_on" IS NULL OR "expires_on" IS NULL OR "issued_on" <= "expires_on"),
        CONSTRAINT "CHK_hr_employee_documents_archive"
          CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_hr_employee_documents_employee"
        ON "hr"."employee_documents" ("employee_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_hr_employee_documents_expiry"
        ON "hr"."employee_documents" ("expires_on") WHERE "status" = 'ACTIVE' AND "expires_on" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hr"."employee_document_versions" (
        "id" SERIAL NOT NULL,
        "document_id" integer NOT NULL,
        "version_no" integer NOT NULL,
        "file_id" integer NOT NULL,
        "change_note" varchar(500),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "created_by" integer,
        CONSTRAINT "PK_hr_employee_document_versions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_hr_employee_document_versions_document" FOREIGN KEY ("document_id")
          REFERENCES "hr"."employee_documents"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_hr_employee_document_versions_file" FOREIGN KEY ("file_id")
          REFERENCES "hr"."files"("id") ON DELETE RESTRICT,
        CONSTRAINT "UQ_hr_employee_document_versions_no" UNIQUE ("document_id", "version_no"),
        CONSTRAINT "UQ_hr_employee_document_versions_file" UNIQUE ("file_id"),
        CONSTRAINT "CHK_hr_employee_document_versions_no" CHECK ("version_no" >= 1)
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."employee_documents"
        ADD CONSTRAINT "FK_hr_employee_documents_current_version" FOREIGN KEY ("current_version_id")
          REFERENCES "hr"."employee_document_versions"("id") ON DELETE RESTRICT
    `);

    await queryRunner.query(`
      INSERT INTO "hr"."permissions" ("code", "description", "is_sensitive") VALUES
        ('DOCUMENT_VIEW', 'Xem hồ sơ tài liệu nhân viên (metadata, nội dung loại không nhạy cảm)', false),
        ('DOCUMENT_MANAGE', 'Tải lên, thêm phiên bản, sửa, lưu trữ tài liệu nhân viên', false),
        ('HEALTH_DOCUMENT_VIEW', 'Xem nội dung giấy khám sức khỏe (nhạy cảm)', true)
      ON CONFLICT ("code") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "hr"."hr_role_permissions" ("role_code", "permission_code") VALUES
        ('HR_OFFICER', 'DOCUMENT_VIEW'),
        ('HR_OFFICER', 'DOCUMENT_MANAGE')
      ON CONFLICT ("role_code", "permission_code") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "hr"."role_permissions" ("role", "permission_code", "scope") VALUES
        ('nhansu', 'DOCUMENT_VIEW', 'COMPANY'),
        ('nhansu', 'DOCUMENT_MANAGE', 'COMPANY')
      ON CONFLICT ("role", "permission_code") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('"hr"."employee_documents"') IS NOT NULL
           AND EXISTS (SELECT 1 FROM "hr"."employee_documents") THEN
          RAISE EXCEPTION 'hr.employee_documents có dữ liệu — rollback tay sau khi backup';
        END IF;
        IF EXISTS (SELECT 1 FROM "hr"."account_permission_grants"
                    WHERE "permission_code" IN ('DOCUMENT_VIEW','DOCUMENT_MANAGE','HEALTH_DOCUMENT_VIEW')) THEN
          RAISE EXCEPTION 'Quyền tài liệu đang được cấp lẻ — thu hồi trước khi rollback';
        END IF;
      END $$
    `);
    await queryRunner.query(
      `DELETE FROM "hr"."role_permissions" WHERE "permission_code" IN ('DOCUMENT_VIEW','DOCUMENT_MANAGE','HEALTH_DOCUMENT_VIEW')`,
    );
    await queryRunner.query(
      `DELETE FROM "hr"."hr_role_permissions" WHERE "permission_code" IN ('DOCUMENT_VIEW','DOCUMENT_MANAGE','HEALTH_DOCUMENT_VIEW')`,
    );
    await queryRunner.query(
      `DELETE FROM "hr"."permissions" WHERE "code" IN ('DOCUMENT_VIEW','DOCUMENT_MANAGE','HEALTH_DOCUMENT_VIEW')`,
    );
    await queryRunner.query(`
      ALTER TABLE "hr"."employee_documents" DROP CONSTRAINT IF EXISTS "FK_hr_employee_documents_current_version"
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hr"."employee_document_versions"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "hr"."employee_documents"`);
  }
}
