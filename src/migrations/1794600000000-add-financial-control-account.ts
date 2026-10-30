import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFinancialControlAccount1794600000000 implements MigrationInterface {
  name = 'AddFinancialControlAccount1794600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "financial_requests"
      ADD COLUMN IF NOT EXISTS "control_cash_account_code" character varying(20)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "financial_requests"
      DROP COLUMN IF EXISTS "control_cash_account_code"
    `);
  }
}
