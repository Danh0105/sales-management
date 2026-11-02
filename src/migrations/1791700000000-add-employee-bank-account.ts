import { MigrationInterface, QueryRunner } from 'typeorm';

/** Thông tin tài khoản nhận lương dùng chung cho mọi nhân viên, gồm cả CTV. */
export class AddEmployeeBankAccount1791700000000 implements MigrationInterface {
  name = 'AddEmployeeBankAccount1791700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "employee"
      ADD COLUMN IF NOT EXISTS "bank_account_number" varchar(50),
      ADD COLUMN IF NOT EXISTS "bank_name" varchar(255)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "employee"
      DROP COLUMN IF EXISTS "bank_name",
      DROP COLUMN IF EXISTS "bank_account_number"
    `);
  }
}
