import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề xuất chi lấy khoản chưa chi từ QL thu chi (13/11/2026):
 * - `suggest.cashflow_source`: bảng nguồn của đề xuất chi tháng — MANAGEMENT
 *   (Chi Ngoài, đề xuất chi tháng cũ để trống = MANAGEMENT), SCHOOL_EXPENSE
 *   (Chi Trường), SCHOOL_TEACHER (Giáo viên trường).
 * - `suggest_monthly_items.school_teacher_id`: khoản lương của một giáo viên.
 * - `suggest_monthly_items.requested_amount`: Còn phải chi lúc tạo/sửa đề xuất.
 * - `school_expense_suggest_payments` / `school_teacher_suggest_payments`: phần
 *   đề xuất ghi vào từng dòng Chi Trường / Giáo viên trường khi kinh doanh xác
 *   nhận đã chi (giống `management_expense_suggest_payments` của Chi Ngoài).
 * Chỉ thêm cột nullable / bảng mới, không đụng dữ liệu cũ; chạy lại an toàn.
 */
export class AddExpenseCashflowSources1796200000000 implements MigrationInterface {
  name = 'AddExpenseCashflowSources1796200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "cashflow_source" character varying(20)`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'CHK_suggest_cashflow_source'
         ) THEN
           ALTER TABLE "suggest" ADD CONSTRAINT "CHK_suggest_cashflow_source"
             CHECK ("cashflow_source" IS NULL
               OR "cashflow_source" IN ('MANAGEMENT', 'SCHOOL_EXPENSE', 'SCHOOL_TEACHER'));
         END IF;
       END $$`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" ADD COLUMN IF NOT EXISTS "school_teacher_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" ADD COLUMN IF NOT EXISTS "requested_amount" numeric(18,2)`,
    );
    await queryRunner.query(
      `DO $$ BEGIN
         IF NOT EXISTS (
           SELECT 1 FROM pg_constraint WHERE conname = 'FK_suggest_monthly_items_school_teacher'
         ) THEN
           ALTER TABLE "suggest_monthly_items" ADD CONSTRAINT "FK_suggest_monthly_items_school_teacher"
             FOREIGN KEY ("school_teacher_id") REFERENCES "school_teachers"("id") ON DELETE SET NULL;
         END IF;
       END $$`,
    );
    // Tra khoản đang nằm trong đề xuất chưa xong theo bảng thu chi (trường + kỳ).
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_suggest_monthly_items_period"
        ON "suggest_monthly_items" ("expense_period_id")`,
    );

    for (const [table, itemTable, fk] of [
      [
        'school_expense_suggest_payments',
        'school_expense_items',
        'school_expense_item_id',
      ],
      [
        'school_teacher_suggest_payments',
        'school_teacher_expense_items',
        'school_teacher_expense_item_id',
      ],
    ]) {
      await queryRunner.query(
        `CREATE TABLE IF NOT EXISTS "${table}" (
          "id" SERIAL NOT NULL,
          "${fk}" integer NOT NULL,
          "suggest_id" integer NOT NULL,
          "suggest_monthly_item_id" integer,
          "amount" numeric(15,2) NOT NULL,
          "paid_date" date NOT NULL,
          "cash_account" character varying(20),
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_${table}" PRIMARY KEY ("id"),
          CONSTRAINT "CHK_${table}_amount" CHECK ("amount" > 0),
          CONSTRAINT "FK_${table}_item" FOREIGN KEY ("${fk}")
            REFERENCES "${itemTable}"("id") ON DELETE CASCADE,
          CONSTRAINT "FK_${table}_suggest" FOREIGN KEY ("suggest_id")
            REFERENCES "suggest"("id") ON DELETE CASCADE,
          CONSTRAINT "FK_${table}_monthly_item" FOREIGN KEY ("suggest_monthly_item_id")
            REFERENCES "suggest_monthly_items"("id") ON DELETE SET NULL
        )`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_item" ON "${table}" ("${fk}")`,
      );
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_suggest" ON "${table}" ("suggest_id")`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "school_teacher_suggest_payments"`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS "school_expense_suggest_payments"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_suggest_monthly_items_period"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" DROP CONSTRAINT IF EXISTS "FK_suggest_monthly_items_school_teacher"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" DROP COLUMN IF EXISTS "requested_amount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest_monthly_items" DROP COLUMN IF EXISTS "school_teacher_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "CHK_suggest_cashflow_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "cashflow_source"`,
    );
  }
}
