import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmployeeZaloUid1787200000000 implements MigrationInterface {
  name = 'AddEmployeeZaloUid1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "zalo_uid" character varying`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_employee_zalo_uid" ON "employee" ("zalo_uid")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_employee_zalo_uid"`);
    await queryRunner.query(
      `ALTER TABLE "employee" DROP COLUMN IF EXISTS "zalo_uid"`,
    );
  }
}
