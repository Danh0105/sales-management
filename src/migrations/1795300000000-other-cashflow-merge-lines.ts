import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THU CHI NGOÀI — gộp thu và chi vào một hợp đồng: mỗi hợp đồng có nhiều
 * khoản thu (`other_cashflow_items`) và nhiều khoản chi (`other_cashflow_costs`),
 * mỗi khoản SL × đơn giá + thuế VAT riêng (không thuế / 0 / 5 / 8 / 10%).
 * Lợi nhuận = tổng thu chưa thuế − tổng chi chưa thuế.
 *
 * - `amount` của hợp đồng = tổng phải thu GỒM thuế (Σ khoản thu), `cost_amount`
 *   = tổng phải chi gồm thuế (Σ khoản chi); thêm `income_vat_amount` /
 *   `cost_vat_amount`. Hợp đồng chỉ có khoản chi thì `amount` = 0.
 * - `direction` thôi bắt buộc: hợp đồng mới để trống, hợp đồng cũ giữ để tra.
 * - Dữ liệu cũ đổi tại chỗ, số đã thu/chi giữ nguyên:
 *   · HĐ Thu thông thường → 1 khoản thu (SL 1 × số tiền, không thuế);
 *   · HĐ Chi thông thường → 1 khoản chi, số đã chi chuyển sang `paid_cost_amount`,
 *     các lần chi gắn `cost_id` vào khoản đó;
 *   · đơn Thương mại: dòng hàng/chi phí giữ nguyên, thêm SL 1 × số tiền cho chi phí.
 *
 * Chạy lại an toàn: đã có cột `income_vat_amount` thì bỏ qua.
 * `down` chỉ chạy được khi chưa có hợp đồng kiểu mới (`direction` trống).
 */
export class OtherCashflowMergeLines1795300000000 implements MigrationInterface {
  name = 'OtherCashflowMergeLines1795300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const done: unknown[] = await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'other_cashflow_contracts' AND column_name = 'income_vat_amount'`,
    );
    if (done.length) return;

    // Hợp đồng
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP CONSTRAINT "CHK_other_cashflow_contracts_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP CONSTRAINT "CHK_other_cashflow_contracts_form"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ALTER COLUMN "direction" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD "income_vat_amount" bigint NOT NULL DEFAULT '0', ADD "cost_vat_amount" bigint NOT NULL DEFAULT '0'`,
    );

    // Khoản thu
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" ALTER COLUMN "item_code" DROP NOT NULL, ADD "vat_rate" smallint, ADD "vat_amount" bigint NOT NULL DEFAULT '0', ADD "total_amount" bigint`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_items" SET "total_amount" = "amount"`,
    );

    // Khoản chi
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" DROP CONSTRAINT "CHK_other_cashflow_costs_amounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD "item_code" character varying(50), ADD "unit" character varying(30), ADD "quantity" numeric(15,4), ADD "unit_price" numeric(18,2), ADD "vat_rate" smallint, ADD "vat_amount" bigint NOT NULL DEFAULT '0', ADD "total_amount" bigint`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_costs" SET "quantity" = 1, "unit_price" = "amount", "total_amount" = "amount"`,
    );

    // HĐ Thu thông thường → 1 khoản thu.
    await queryRunner.query(
      `INSERT INTO "other_cashflow_items" ("contract_id", "line_no", "item_code", "item_name", "unit", "quantity", "unit_price", "amount", "vat_rate", "vat_amount", "total_amount")
       SELECT c."id", 1, NULL, c."title", NULL, 1, c."amount", c."amount", NULL, 0, c."amount"
       FROM "other_cashflow_contracts" c
       WHERE c."form" = 'STANDARD' AND c."direction" = 'IN'
         AND NOT EXISTS (SELECT 1 FROM "other_cashflow_items" i WHERE i."contract_id" = c."id")`,
    );
    // HĐ Chi thông thường → 1 khoản chi (đối tượng vẫn là đối tác của hợp đồng).
    await queryRunner.query(
      `INSERT INTO "other_cashflow_costs" ("contract_id", "line_no", "description", "payee", "amount", "paid_amount", "item_code", "unit", "quantity", "unit_price", "vat_rate", "vat_amount", "total_amount")
       SELECT c."id", 1, c."title", NULL, c."amount", c."recorded_amount", NULL, NULL, 1, c."amount", NULL, 0, c."amount"
       FROM "other_cashflow_contracts" c
       WHERE c."form" = 'STANDARD' AND c."direction" = 'OUT'
         AND NOT EXISTS (SELECT 1 FROM "other_cashflow_costs" k WHERE k."contract_id" = c."id")`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_entries" e SET "cost_id" = k."id"
       FROM "other_cashflow_costs" k, "other_cashflow_contracts" c
       WHERE c."id" = e."contract_id" AND k."contract_id" = c."id"
         AND c."form" = 'STANDARD' AND c."direction" = 'OUT'
         AND e."flow" = 'OUT' AND e."cost_id" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_contracts"
       SET "cost_amount" = "amount", "paid_cost_amount" = "recorded_amount", "amount" = 0, "recorded_amount" = 0
       WHERE "form" = 'STANDARD' AND "direction" = 'OUT'`,
    );

    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" ALTER COLUMN "total_amount" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ALTER COLUMN "quantity" SET NOT NULL, ALTER COLUMN "unit_price" SET NOT NULL, ALTER COLUMN "total_amount" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "CHK_other_cashflow_contracts_amount" CHECK ("amount" >= 0 AND "amount" + "cost_amount" > 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "CHK_other_cashflow_contracts_form" CHECK ("form" IN ('STANDARD','COMMERCIAL'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "CHK_other_cashflow_contracts_vat" CHECK ("income_vat_amount" >= 0 AND "income_vat_amount" <= "amount" AND "cost_vat_amount" >= 0 AND "cost_vat_amount" <= "cost_amount")`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" ADD CONSTRAINT "CHK_other_cashflow_items_vat" CHECK (("vat_rate" IS NULL OR "vat_rate" BETWEEN 0 AND 100) AND ("vat_rate" IS NOT NULL OR "vat_amount" = 0) AND "vat_amount" >= 0 AND "total_amount" = "amount" + "vat_amount")`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD CONSTRAINT "CHK_other_cashflow_costs_values" CHECK ("quantity" > 0 AND "unit_price" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD CONSTRAINT "CHK_other_cashflow_costs_vat" CHECK (("vat_rate" IS NULL OR "vat_rate" BETWEEN 0 AND 100) AND ("vat_rate" IS NOT NULL OR "vat_amount" = 0) AND "vat_amount" >= 0 AND "total_amount" = "amount" + "vat_amount")`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD CONSTRAINT "CHK_other_cashflow_costs_amounts" CHECK ("amount" >= 0 AND "total_amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "total_amount")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const merged: { count: number }[] = await queryRunner.query(
      `SELECT count(*)::int AS count FROM "other_cashflow_contracts"
       WHERE "direction" IS NULL OR "income_vat_amount" > 0 OR "cost_vat_amount" > 0`,
    );
    if (merged[0]?.count) {
      throw new Error(
        `Đã có ${merged[0].count} hợp đồng Thu Chi ngoài kiểu gộp thu chi / có thuế — không quay lại cấu trúc cũ được, xử lý tay`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" DROP CONSTRAINT "CHK_other_cashflow_costs_amounts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" DROP CONSTRAINT "CHK_other_cashflow_costs_vat"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" DROP CONSTRAINT "CHK_other_cashflow_costs_values"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" DROP CONSTRAINT "CHK_other_cashflow_items_vat"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP CONSTRAINT "CHK_other_cashflow_contracts_vat"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP CONSTRAINT "CHK_other_cashflow_contracts_form"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP CONSTRAINT "CHK_other_cashflow_contracts_amount"`,
    );

    // HĐ Chi thông thường: trả số tiền về hợp đồng, gỡ khoản chi đã sinh.
    await queryRunner.query(
      `UPDATE "other_cashflow_contracts"
       SET "amount" = "cost_amount", "recorded_amount" = "paid_cost_amount", "cost_amount" = 0, "paid_cost_amount" = 0
       WHERE "form" = 'STANDARD' AND "direction" = 'OUT'`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_entries" e SET "cost_id" = NULL
       FROM "other_cashflow_contracts" c
       WHERE c."id" = e."contract_id" AND c."form" = 'STANDARD' AND c."direction" = 'OUT'`,
    );
    await queryRunner.query(
      `DELETE FROM "other_cashflow_costs" k USING "other_cashflow_contracts" c
       WHERE c."id" = k."contract_id" AND c."form" = 'STANDARD'`,
    );
    await queryRunner.query(
      `DELETE FROM "other_cashflow_items" i USING "other_cashflow_contracts" c
       WHERE c."id" = i."contract_id" AND c."form" = 'STANDARD'`,
    );

    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" DROP COLUMN "total_amount", DROP COLUMN "vat_amount", DROP COLUMN "vat_rate", DROP COLUMN "unit_price", DROP COLUMN "quantity", DROP COLUMN "unit", DROP COLUMN "item_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD CONSTRAINT "CHK_other_cashflow_costs_amounts" CHECK ("amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "amount")`,
    );
    await queryRunner.query(
      `UPDATE "other_cashflow_items" SET "item_code" = '' WHERE "item_code" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" DROP COLUMN "total_amount", DROP COLUMN "vat_amount", DROP COLUMN "vat_rate", ALTER COLUMN "item_code" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" DROP COLUMN "cost_vat_amount", DROP COLUMN "income_vat_amount", ALTER COLUMN "direction" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "CHK_other_cashflow_contracts_form" CHECK ("form" IN ('STANDARD','COMMERCIAL') AND ("form" = 'STANDARD' OR "direction" = 'IN'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "CHK_other_cashflow_contracts_amount" CHECK ("amount" > 0)`,
    );
  }
}
