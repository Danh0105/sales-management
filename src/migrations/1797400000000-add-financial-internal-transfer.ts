import { MigrationInterface, QueryRunner } from 'typeorm';

const OLD_TYPES = `'ADVANCE','SALARY_ADVANCE','SETTLEMENT','EXPENSE_PAYMENT'`;
const NEW_TYPES = `${OLD_TYPES},'INTERNAL_TRANSFER'`;

/**
 * Đề nghị tài chính nội bộ — loại "Điều chuyển tiền nội bộ" (20/11/2026): từ
 * nguồn (tài khoản 111/112) này sang nguồn khác.
 * - 2 cột nguồn chuyển / nguồn nhận (nullable);
 * - mở CHECK loại phiếu của phiếu + quy trình;
 * - tạo sẵn quy trình "Điều chuyển tiền nội bộ" 1 bước Giám đốc duyệt (sửa được
 *   ở màn Cấu hình). Giám đốc tự lập phiếu thì bỏ qua bước của mình (SKIP_STEP).
 */
export class AddFinancialInternalTransfer1797400000000 implements MigrationInterface {
  name = 'AddFinancialInternalTransfer1797400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "financial_requests"
         ADD COLUMN IF NOT EXISTS "transfer_from_account_code" character varying(20),
         ADD COLUMN IF NOT EXISTS "transfer_to_account_code" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" DROP CONSTRAINT IF EXISTS "CHK_financial_requests_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "CHK_financial_requests_type" CHECK ("type" IN (${NEW_TYPES}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_workflows" DROP CONSTRAINT IF EXISTS "CHK_financial_approval_workflows_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_workflows" ADD CONSTRAINT "CHK_financial_approval_workflows_type" CHECK ("request_type" IS NULL OR "request_type" IN (${NEW_TYPES}))`,
    );
    await queryRunner.query(
      `INSERT INTO "financial_approval_workflows"
         ("name", "request_type", "is_active", "is_sequential", "self_approval_mode", "allow_withdraw", "description")
       SELECT 'Quy trình điều chuyển tiền nội bộ', 'INTERNAL_TRANSFER', true, true, 'SKIP_STEP', true,
              'Giám đốc duyệt, sau đó Thủ quỹ thực hiện điều chuyển'
       WHERE NOT EXISTS (
         SELECT 1 FROM "financial_approval_workflows" WHERE "request_type" = 'INTERNAL_TRANSFER'
       )`,
    );
    await queryRunner.query(
      `INSERT INTO "financial_workflow_steps"
         ("workflow_id", "step_order", "name", "signature_slot", "approver_type", "approver_role", "can_adjust_amounts", "skippable")
       SELECT w.id, 1, 'Giám đốc duyệt', 'DIRECTOR', 'ROLE', 'DIRECTOR', true, false
       FROM "financial_approval_workflows" w
       WHERE w."request_type" = 'INTERNAL_TRANSFER'
         AND NOT EXISTS (SELECT 1 FROM "financial_workflow_steps" s WHERE s.workflow_id = w.id)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "financial_workflow_steps" WHERE workflow_id IN (
         SELECT id FROM "financial_approval_workflows" WHERE "request_type" = 'INTERNAL_TRANSFER')`,
    );
    await queryRunner.query(
      `DELETE FROM "financial_approval_workflows" WHERE "request_type" = 'INTERNAL_TRANSFER'`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_workflows" DROP CONSTRAINT IF EXISTS "CHK_financial_approval_workflows_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_workflows" ADD CONSTRAINT "CHK_financial_approval_workflows_type" CHECK ("request_type" IS NULL OR "request_type" IN (${OLD_TYPES}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" DROP CONSTRAINT IF EXISTS "CHK_financial_requests_type"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "CHK_financial_requests_type" CHECK ("type" IN (${OLD_TYPES}))`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests"
         DROP COLUMN IF EXISTS "transfer_to_account_code",
         DROP COLUMN IF EXISTS "transfer_from_account_code"`,
    );
  }
}
