import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng con `management_expense_other_costs` — chi tiết từng khoản "Chi khác"
 * của mỗi dòng `management_expense_items`.
 *
 * Lưu ý: runtime hiện chạy `synchronize: true` nên schema được tạo tự động.
 * Migration này dành cho môi trường TẮT synchronize (deploy an toàn).
 */
export class CreateManagementExpenseOtherCosts1785200000000
  implements MigrationInterface
{
  name = 'CreateManagementExpenseOtherCosts1785200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "management_expense_other_costs" (
        "id" SERIAL NOT NULL,
        "management_expense_item_id" integer NOT NULL,
        "policyOtherCostId" integer,
        "name" character varying(255),
        "unitPrice" numeric(15,2) NOT NULL DEFAULT 0,
        "amount" numeric(15,2) NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_management_expense_other_costs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mgmt_other_cost_item"
      ON "management_expense_other_costs" ("management_expense_item_id")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_mgmt_other_cost_policy"
      ON "management_expense_other_costs" ("policyOtherCostId")
    `);

    // Không cho trùng cùng 1 khoản chính sách trong 1 dòng (chỉ khi có policyOtherCostId).
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_mgmt_other_cost_item_policy"
      ON "management_expense_other_costs" ("management_expense_item_id", "policyOtherCostId")
      WHERE "policyOtherCostId" IS NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "management_expense_other_costs"
      ADD CONSTRAINT "FK_mgmt_other_cost_item"
      FOREIGN KEY ("management_expense_item_id")
      REFERENCES "management_expense_items"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "management_expense_other_costs"
      DROP CONSTRAINT IF EXISTS "FK_mgmt_other_cost_item"
    `);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_mgmt_other_cost_item_policy"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mgmt_other_cost_policy"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mgmt_other_cost_item"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "management_expense_other_costs"`,
    );
  }
}
