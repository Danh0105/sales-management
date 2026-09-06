import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Thêm thuế (đơn giá thuế tuyệt đối + thành tiền thuế) cho chi ngoài:
 * - management_expense_items: ql1Tax, ql2Tax, ql1TaxAmount, ql2TaxAmount, totalTaxAmount.
 * - management_expense_other_costs: tax, taxAmount.
 *
 * Thuế KHÔNG cộng vào totalOutside — chỉ để báo cáo (totalTaxAmount).
 * Runtime chạy synchronize:true nên cột được thêm tự động; migration cho môi trường tắt synchronize.
 */
export class AddTaxToManagementExpense1785300000000
  implements MigrationInterface
{
  name = 'AddTaxToManagementExpense1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "management_expense_items"
        ADD COLUMN IF NOT EXISTS "ql1Tax" numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "ql2Tax" numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "ql1TaxAmount" numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "ql2TaxAmount" numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "totalTaxAmount" numeric(15,2) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "management_expense_other_costs"
        ADD COLUMN IF NOT EXISTS "tax" numeric(15,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "taxAmount" numeric(15,2) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "management_expense_other_costs"
        DROP COLUMN IF EXISTS "taxAmount",
        DROP COLUMN IF EXISTS "tax"
    `);
    await queryRunner.query(`
      ALTER TABLE "management_expense_items"
        DROP COLUMN IF EXISTS "totalTaxAmount",
        DROP COLUMN IF EXISTS "ql2TaxAmount",
        DROP COLUMN IF EXISTS "ql1TaxAmount",
        DROP COLUMN IF EXISTS "ql2Tax",
        DROP COLUMN IF EXISTS "ql1Tax"
    `);
  }
}
