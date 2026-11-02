import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Phase 1.3 (quyết định 05/10/2026) — ACTIVE chỉ còn nghĩa là PHIÊN BẢN HIỆN
 * HÀNH. File của phiên bản cũ (bị thay thế) chuyển sang ARCHIVED; người có
 * quyền vẫn xem lại được (HrFileService cho phép đúng trường hợp: phiên bản cũ
 * của tài liệu còn ACTIVE).
 *
 * Chỉ cập nhật các file: là phiên bản của một tài liệu, KHÔNG phải phiên bản
 * hiện hành, đang ACTIVE. Chạy lại không đổi thêm gì. Không xoá dòng nào.
 *
 * Rủi ro: CAUTION — sửa dữ liệu trạng thái của `hr.files` (bảng 0.4C).
 * Rollback: `down()` không hoàn tác trạng thái (không phân biệt được với các
 * lần thay phiên bản sau này) — chủ ý, an toàn hơn đoán ngược.
 */
export class HrSupersededDocumentVersions1791700001130 implements MigrationInterface {
  name = 'HrSupersededDocumentVersions1791700001130';
  static readonly risk: MigrationRisk = 'CAUTION';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "hr"."files" f
         SET "status" = 'ARCHIVED',
             "archived_at" = now(),
             "archive_reason" = 'Phiên bản cũ — đã có phiên bản mới',
             "version" = f."version" + 1
        FROM "hr"."employee_document_versions" v
        JOIN "hr"."employee_documents" d ON d."id" = v."document_id"
       WHERE v."file_id" = f."id"
         AND v."id" IS DISTINCT FROM d."current_version_id"
         AND f."status" = 'ACTIVE'
    `);
  }

  public async down(): Promise<void> {
    // Không hoàn tác: xem chú thích lớp.
  }
}
