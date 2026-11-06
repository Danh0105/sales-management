import { MigrationInterface, QueryRunner } from 'typeorm';

/** Thêm bước Kế toán công nợ nhập số tiền trước khi Giám đốc duyệt chi tháng. */
export class AddMonthlyExpenseWorkflow1792700000000 implements MigrationInterface {
  name = 'AddMonthlyExpenseWorkflow1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_ACCOUNTING'`,
    );
  }

  public async down(): Promise<void> {
    // PostgreSQL không hỗ trợ xoá trực tiếp một giá trị enum an toàn khi vẫn
    // có dữ liệu dùng giá trị đó. Giữ no-op giống các migration enum hiện có.
  }
}
