import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFinancialRequestPaymentAccount1794600000000 implements MigrationInterface {
  name = 'AddFinancialRequestPaymentAccount1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "financial_requests"
      ADD COLUMN IF NOT EXISTS "payment_account_code" character varying(20)
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_financial_requests_payment_account'
        ) THEN
          ALTER TABLE "financial_requests"
          ADD CONSTRAINT "FK_financial_requests_payment_account"
          FOREIGN KEY ("payment_account_code")
          REFERENCES "cash_accounts"("code")
          ON DELETE SET NULL;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "financial_requests"
      DROP CONSTRAINT IF EXISTS "FK_financial_requests_payment_account"
    `);
    await queryRunner.query(`
      ALTER TABLE "financial_requests"
      DROP COLUMN IF EXISTS "payment_account_code"
    `);
  }
}
