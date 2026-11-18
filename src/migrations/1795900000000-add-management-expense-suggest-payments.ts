import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chi Ngoài — `management_expense_suggest_payments`: phần "Đã chi" của một dòng
 * Chi Ngoài do đề xuất chi tháng ghi vào khi kinh doanh xác nhận đã chi.
 * Cột `paidAmount` của dòng vẫn là tổng (nhập tay + đề xuất) để mọi màn đọc
 * Còn chi không phải đổi; bảng này cho biết phần nào đến từ đề xuất để khoá ô,
 * hiện mã đề xuất và để sổ thu chi không tính tiền hai lần.
 * Bảng mới, không đụng dữ liệu cũ; `IF NOT EXISTS` để chạy lại an toàn.
 */
export class AddManagementExpenseSuggestPayments1795900000000
  implements MigrationInterface
{
  name = 'AddManagementExpenseSuggestPayments1795900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "management_expense_suggest_payments" (
        "id" SERIAL NOT NULL,
        "management_expense_item_id" integer NOT NULL,
        "suggest_id" integer NOT NULL,
        "suggest_monthly_item_id" integer,
        "amount" numeric(15,2) NOT NULL,
        "paid_date" date NOT NULL,
        "cash_account" character varying(20),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_management_expense_suggest_payments" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_management_expense_suggest_payments_amount" CHECK ("amount" > 0),
        CONSTRAINT "FK_management_expense_suggest_payments_item" FOREIGN KEY ("management_expense_item_id")
          REFERENCES "management_expense_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_management_expense_suggest_payments_suggest" FOREIGN KEY ("suggest_id")
          REFERENCES "suggest"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_management_expense_suggest_payments_monthly_item" FOREIGN KEY ("suggest_monthly_item_id")
          REFERENCES "suggest_monthly_items"("id") ON DELETE SET NULL
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_management_expense_suggest_payments_item"
        ON "management_expense_suggest_payments" ("management_expense_item_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_management_expense_suggest_payments_suggest"
        ON "management_expense_suggest_payments" ("suggest_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "management_expense_suggest_payments"`,
    );
  }
}
