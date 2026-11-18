import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề nghị thanh toán chi phí chuyển thẳng cho nhà cung cấp:
 * - `financial_request_suppliers`: các NCC nhận tiền của một phiếu, kèm thông
 *   tin chuyển khoản.
 * - `financial_request_items.supplier_id`: dòng chi tiết trả cho NCC nào
 *   (NULL = trả cho người đề nghị, như trước đây).
 * - `financial_payments.supplier_id`: lần chi này chuyển cho NCC nào
 *   (NULL = chuyển cho người đề nghị).
 *
 * Chỉ thêm bảng + cột nullable, dữ liệu cũ giữ nguyên nghĩa (mọi dòng / lần chi
 * cũ đều là của người đề nghị). `IF NOT EXISTS` để chạy lại an toàn.
 */
export class AddFinancialRequestSuppliers1795700000000
  implements MigrationInterface
{
  name = 'AddFinancialRequestSuppliers1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "financial_request_suppliers" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "line_no" smallint NOT NULL,
        "name" character varying(255) NOT NULL,
        "bank_account_holder" character varying(255),
        "bank_name" character varying(255),
        "bank_account_number" character varying(50),
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_financial_request_suppliers" PRIMARY KEY ("id"),
        CONSTRAINT "FK_financial_request_suppliers_request" FOREIGN KEY ("request_id")
          REFERENCES "financial_requests"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_financial_request_suppliers_request"
        ON "financial_request_suppliers" ("request_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "financial_request_items"
        ADD COLUMN IF NOT EXISTS "supplier_id" integer`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_financial_request_items_supplier') THEN
          ALTER TABLE "financial_request_items"
            ADD CONSTRAINT "FK_financial_request_items_supplier" FOREIGN KEY ("supplier_id")
            REFERENCES "financial_request_suppliers"("id") ON DELETE SET NULL;
        END IF;
      END $$`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_financial_request_items_supplier"
        ON "financial_request_items" ("supplier_id")`,
    );

    await queryRunner.query(
      `ALTER TABLE "financial_payments"
        ADD COLUMN IF NOT EXISTS "supplier_id" integer`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_financial_payments_supplier') THEN
          ALTER TABLE "financial_payments"
            ADD CONSTRAINT "FK_financial_payments_supplier" FOREIGN KEY ("supplier_id")
            REFERENCES "financial_request_suppliers"("id") ON DELETE RESTRICT;
        END IF;
      END $$`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_financial_payments_supplier"
        ON "financial_payments" ("supplier_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "financial_payments" DROP COLUMN IF EXISTS "supplier_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_items" DROP COLUMN IF EXISTS "supplier_id"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "financial_request_suppliers"`,
    );
  }
}
