import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tổng hợp thu chi — `cash_manual_entries`: bút toán thu/chi/chuyển nội bộ
 * nhập tay (thủ quỹ, kế toán trưởng, giám đốc). Bảng mới, không đụng dữ liệu
 * cũ; `IF NOT EXISTS` để chạy lại an toàn.
 */
export class AddCashManualEntries1795100000000 implements MigrationInterface {
  name = 'AddCashManualEntries1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "cash_manual_entries" (
        "id" SERIAL NOT NULL,
        "kind" character varying(10) NOT NULL,
        "entry_date" date NOT NULL,
        "account_code" character varying(20) NOT NULL,
        "counter_account_code" character varying(20),
        "amount" numeric(18,2) NOT NULL,
        "document_no" character varying(50),
        "description" character varying(500) NOT NULL,
        "partner_name" character varying(255),
        "note" text,
        "created_by" integer NOT NULL,
        "created_by_name" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by" integer,
        "updated_by_name" character varying(255),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "deleted_by" integer,
        "deleted_by_name" character varying(255),
        CONSTRAINT "CHK_cash_manual_entries_kind" CHECK ("kind" IN ('IN','OUT','TRANSFER')),
        CONSTRAINT "CHK_cash_manual_entries_amount" CHECK ("amount" > 0),
        CONSTRAINT "CHK_cash_manual_entries_counter" CHECK (("kind" = 'TRANSFER') = ("counter_account_code" IS NOT NULL) AND ("counter_account_code" IS NULL OR "counter_account_code" <> "account_code")),
        CONSTRAINT "PK_cash_manual_entries" PRIMARY KEY ("id")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cash_manual_entries"`);
  }
}
