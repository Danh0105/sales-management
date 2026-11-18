import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Quy trình Kế toán cho Đề xuất Chi Ngoài / Chi Trường / Chi GV trường
 * (16/11/2026): thêm 2 trạng thái (chờ Kế toán nhập số liệu, chờ Kế toán trưởng
 * duyệt) và cột `approval_flow` đánh dấu đề xuất đi quy trình mới. Chỉ thêm
 * giá trị enum và cột nullable, không đổi dữ liệu.
 */
export class AddExpenseAccountantChain1796300000000 implements MigrationInterface {
  name = 'AddExpenseAccountantChain1796300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_ACCOUNTANT'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_CHIEF_APPROVAL'`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "approval_flow" character varying(30)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "approval_flow"`,
    );
    // Giá trị enum giữ lại: PostgreSQL không xoá an toàn được.
  }
}
