import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hóa đơn điện tử Viettel (nháp) gộp các dòng doanh thu "Xuất HĐ Cty" của 1
 * môn + lưu ĐVT của dòng. `IF NOT EXISTS` để chạy an toàn cả khi synchronize
 * đã tạo trước — kể cả bảng tạo theo bản đầu (mỗi dòng 1 hóa đơn, row_index
 * bắt buộc): giữ row_index cho các hóa đơn đó, hóa đơn gộp dùng `lines`.
 */
export class AddRevenueEinvoices1791600000000 implements MigrationInterface {
  name = 'AddRevenueEinvoices1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoiceUnit" character varying(50)`,
    );
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "revenue_einvoices" (
      "id" SERIAL NOT NULL,
      "school_expense_id" integer NOT NULL,
      "subject_id" integer NOT NULL,
      "row_index" integer,
      "supplier_tax_code" character varying(20),
      "transaction_uuid" uuid NOT NULL,
      "status" character varying(20) NOT NULL,
      "lines" jsonb NOT NULL DEFAULT '[]',
      "amount" numeric(15,2) NOT NULL DEFAULT 0,
      "buyer_name" character varying(500) NOT NULL,
      "buyer_tax_code" character varying(20) NOT NULL,
      "payload_hash" character varying(64),
      "viettel_transaction_id" character varying(100),
      "error_code" character varying(100),
      "error_message" text,
      "raw_request" jsonb,
      "raw_response" jsonb,
      "drafted_at" TIMESTAMP WITH TIME ZONE,
      "exported_by" integer,
      "exported_by_name" character varying(255),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_revenue_einvoices" PRIMARY KEY ("id"),
      CONSTRAINT "FK_revenue_einvoices_school_expense" FOREIGN KEY ("school_expense_id") REFERENCES "school_expenses"("id") ON DELETE CASCADE,
      CONSTRAINT "FK_revenue_einvoices_subject" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(
      `ALTER TABLE "revenue_einvoices" ADD COLUMN IF NOT EXISTS "supplier_tax_code" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_einvoices" ADD COLUMN IF NOT EXISTS "lines" jsonb NOT NULL DEFAULT '[]'`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_einvoices" ALTER COLUMN "row_index" DROP NOT NULL`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_revenue_einvoices_row"`);
    await queryRunner.query(
      `ALTER TABLE "revenue_einvoices" DROP COLUMN IF EXISTS "item_name", DROP COLUMN IF EXISTS "quantity", DROP COLUMN IF EXISTS "unit_price"`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_revenue_einvoices_subject" ON "revenue_einvoices" ("school_expense_id", "subject_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_revenue_einvoices_transaction_uuid" ON "revenue_einvoices" ("transaction_uuid")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "revenue_einvoices"`);
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoiceUnit"`,
    );
  }
}
