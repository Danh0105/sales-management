import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Schema `hr` — nơi chứa toàn bộ dữ liệu của module HRM, tách khỏi `public`.
 *
 * Rủi ro: SAFE — chỉ tạo schema rỗng, idempotent, không khoá bảng nào của
 * hệ thống cũ. Runner cũng tạo schema này trước khi dựng `hr.migrations`;
 * migration vẫn giữ để lịch sử schema có điểm khởi đầu rõ ràng.
 *
 * Rollback: `down()` cố ý không xoá gì. Schema chứa chính bảng `hr.migrations`
 * và về sau là dữ liệu nhân sự; gỡ schema là quyết định của DBA, làm tay sau
 * khi đã backup — không bao giờ là một lệnh revert tự động.
 */
export class HrCreateSchema1791700000000 implements MigrationInterface {
  name = 'HrCreateSchema1791700000000';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "hr"`);
    await queryRunner.query(
      `COMMENT ON SCHEMA "hr" IS 'HRM module — quản lý bằng src/hr/migrations, KHÔNG dùng synchronize'`,
    );
  }

  public async down(): Promise<void> {
    // Cố ý không làm gì — xem comment của class.
  }
}
