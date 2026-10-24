import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Báo cáo tổng hợp thu chi:
 * - `cash_accounts`: danh mục tài khoản tiền (trước đây chỉ có trong code,
 *   `INVOICE_CASH_ACCOUNTS`) kèm trạng thái sử dụng và số dư gốc tại một ngày
 *   đối chiếu. Số dư gốc để NULL cho tới khi kế toán trưởng nhập — báo cáo
 *   coi là "chưa xác minh", không coi là 0.
 * - Hóa Đơn: "Thu/Chi" + "Số tiền" của khoản ở cột "Khoản thu/chi".
 * - Chi Trường: "Nguồn chi".
 * Mọi cột thêm vào bảng cũ đều nullable, không default → chỉ đổi metadata,
 * bản ghi cũ nhận NULL. `IF NOT EXISTS` / `ON CONFLICT` để chạy lại an toàn.
 */
export class AddCashflowReport1794100000000 implements MigrationInterface {
  name = 'AddCashflowReport1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "cash_accounts" (
        "id" SERIAL PRIMARY KEY,
        "code" character varying(20) NOT NULL,
        "name" character varying(200) NOT NULL,
        "groupCode" character varying(10) NOT NULL,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        "openingBalance" numeric(18,2),
        "openingBalanceDate" date,
        "openingBalanceUpdatedBy" integer,
        "openingBalanceUpdatedByName" character varying(255),
        "openingBalanceUpdatedAt" TIMESTAMP WITH TIME ZONE,
        "note" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_cash_accounts_code" UNIQUE ("code"),
        CONSTRAINT "CHK_cash_accounts_group" CHECK ("groupCode" IN ('111', '112')),
        CONSTRAINT "CHK_cash_accounts_opening_pair"
          CHECK (("openingBalance" IS NULL) = ("openingBalanceDate" IS NULL))
      )
    `);
    await queryRunner.query(`
      INSERT INTO "cash_accounts" ("code", "name", "groupCode", "sortOrder") VALUES
        ('1111', 'Tiền mặt tại quỹ', '111', 10),
        ('1112', 'Tiền TK Sếp Khôi', '111', 20),
        ('1113', 'Tiền mặt - Anh Trung', '111', 30),
        ('1114', 'Tiền mặt - Cầm', '111', 40),
        ('1121', 'TK Techcombank - ICHI', '112', 10),
        ('1125', 'TK MB Bank - ICHI', '112', 20),
        ('1126', 'TK Vietcombank - ICHI', '112', 30),
        ('1127', 'TK Vietinbank - ICHI', '112', 40),
        ('1128', 'TK Techcombank - Chuyển đổi số', '112', 50),
        ('1129', 'TK Techcombank - Kido', '112', 60),
        ('11210', 'TK Vietinbank - Kido', '112', 70),
        ('11211', 'TK Techcombank - Anh Việt', '112', 80),
        ('11212', 'TK MB Bank - ST', '112', 90)
      ON CONFLICT ("code") DO NOTHING
    `);
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoiceCashDirection" character varying(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" ADD COLUMN IF NOT EXISTS "invoiceCashAmount" numeric(15,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "school_expense_items" ADD COLUMN IF NOT EXISTS "cashAccount" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "school_expense_items" DROP COLUMN IF EXISTS "cashAccount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoiceCashAmount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "revenue_items" DROP COLUMN IF EXISTS "invoiceCashDirection"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "cash_accounts"`);
  }
}
