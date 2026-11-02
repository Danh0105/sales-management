import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Phase 1.3 — `hr.files.document_type` nhận thêm các loại do module Documents
 * quản lý: RESUME, DEGREE, CERTIFICATE, HEALTH_CERTIFICATE. Các loại 0.4C giữ
 * nguyên (GENERAL hiển thị là OTHER ở tầng ứng dụng — không đổi dữ liệu).
 *
 * Thay CHECK: ADD bản mới `NOT VALID` → VALIDATE (dữ liệu cũ đều hợp lệ) → bỏ
 * bản cũ. Không đổi dòng nào.
 *
 * Rủi ro: CAUTION — sửa ràng buộc của bảng 0.4C (`hr.files`).
 * Rollback: `down()` từ chối nếu đã có file thuộc loại mới; khôi phục CHECK cũ.
 */
export class HrFilesDocumentTypes1791700001110 implements MigrationInterface {
  name = 'HrFilesDocumentTypes1791700001110';
  static readonly risk: MigrationRisk = 'CAUTION';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hr"."files"
        ADD CONSTRAINT "CHK_hr_files_document_type_v2"
          CHECK ("document_type" IN ('IDENTITY_FRONT','IDENTITY_BACK','BANK_PROOF','CONTRACT','TAX','INSURANCE','GENERAL',
                                     'RESUME','DEGREE','CERTIFICATE','HEALTH_CERTIFICATE')) NOT VALID
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."files" VALIDATE CONSTRAINT "CHK_hr_files_document_type_v2"
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."files" DROP CONSTRAINT IF EXISTS "CHK_hr_files_document_type"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM "hr"."files"
                    WHERE "document_type" IN ('RESUME','DEGREE','CERTIFICATE','HEALTH_CERTIFICATE')) THEN
          RAISE EXCEPTION 'hr.files đã có file loại tài liệu Phase 1.3 — rollback tay sau khi backup';
        END IF;
      END $$
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."files"
        ADD CONSTRAINT "CHK_hr_files_document_type"
          CHECK ("document_type" IN ('IDENTITY_FRONT','IDENTITY_BACK','BANK_PROOF','CONTRACT','TAX','INSURANCE','GENERAL'))
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."files" DROP CONSTRAINT IF EXISTS "CHK_hr_files_document_type_v2"
    `);
  }
}
