import { MigrationInterface, QueryRunner } from 'typeorm';

/** Liên kết đề xuất chi tháng với trường, môn học và kỳ kế toán đã chọn. */
export class AddMonthlyExpenseRequest1792600000000 implements MigrationInterface {
  name = 'AddMonthlyExpenseRequest1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "suggest"
      ADD COLUMN IF NOT EXISTS "is_monthly_expense" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "subject_id" integer,
      ADD COLUMN IF NOT EXISTS "expense_period_id" integer
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_suggest_monthly_expense_period"
      ON "suggest" ("type", "is_monthly_expense", "expense_period_id")
    `);

    const subjectFk = await queryRunner.query(`
      SELECT 1 FROM pg_constraint
      WHERE conname = 'FK_suggest_monthly_subject'
    `);
    if (!subjectFk.length) {
      await queryRunner.query(`
        ALTER TABLE "suggest"
        ADD CONSTRAINT "FK_suggest_monthly_subject"
        FOREIGN KEY ("subject_id") REFERENCES "subjects"("id")
        ON DELETE SET NULL
      `);
    }

    const periodFk = await queryRunner.query(`
      SELECT 1 FROM pg_constraint
      WHERE conname = 'FK_suggest_monthly_expense_period'
    `);
    if (!periodFk.length) {
      await queryRunner.query(`
        ALTER TABLE "suggest"
        ADD CONSTRAINT "FK_suggest_monthly_expense_period"
        FOREIGN KEY ("expense_period_id") REFERENCES "expense_periods"("id")
        ON DELETE SET NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "suggest"
      DROP CONSTRAINT IF EXISTS "FK_suggest_monthly_expense_period"
    `);
    await queryRunner.query(`
      ALTER TABLE "suggest"
      DROP CONSTRAINT IF EXISTS "FK_suggest_monthly_subject"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "public"."idx_suggest_monthly_expense_period"
    `);
    await queryRunner.query(`
      ALTER TABLE "suggest"
      DROP COLUMN IF EXISTS "expense_period_id",
      DROP COLUMN IF EXISTS "subject_id",
      DROP COLUMN IF EXISTS "is_monthly_expense"
    `);
  }
}
