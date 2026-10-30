import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề nghị tài chính — cấp Bộ phận kiểm soát:
 * - `financial_requests.control_cash_account_code`: tài khoản tiền kiểm soát
 *   chọn khi duyệt (mặc định cho lần ghi nhận thanh toán). Nullable, không
 *   default → chỉ đổi metadata, phiếu cũ nhận NULL.
 * - Thêm loại đính kèm `CONTROL_EVIDENCE` vào ràng buộc loại tệp.
 * `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` để chạy lại an toàn.
 */
export class AddFinancialControlAccount1794600000000
  implements MigrationInterface
{
  name = 'AddFinancialControlAccount1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD COLUMN IF NOT EXISTS "control_cash_account_code" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" DROP CONSTRAINT IF EXISTS "CHK_financial_request_attachments_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "CHK_financial_request_attachments_kind" CHECK ("kind" IN ('DOCUMENT','INVOICE','PAYMENT_PROOF','REFUND_PROOF','ADJUSTMENT_EVIDENCE','CONTROL_EVIDENCE'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Tệp kiểm soát đã có vẫn giữ, chỉ trở về loại chứng từ chung.
    await queryRunner.query(
      `UPDATE "financial_request_attachments" SET "kind" = 'DOCUMENT' WHERE "kind" = 'CONTROL_EVIDENCE'`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" DROP CONSTRAINT IF EXISTS "CHK_financial_request_attachments_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "CHK_financial_request_attachments_kind" CHECK ("kind" IN ('DOCUMENT','INVOICE','PAYMENT_PROOF','REFUND_PROOF','ADJUSTMENT_EVIDENCE'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" DROP COLUMN IF EXISTS "control_cash_account_code"`,
    );
  }
}
