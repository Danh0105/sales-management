import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeacherZaloIds1788800000000 implements MigrationInterface {
  name = 'AddTeacherZaloIds1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "zalo_uid" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "zalo_user_id" character varying`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_teachers_zalo_uid" ON "teachers" ("zalo_uid")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_teachers_zalo_user_id" ON "teachers" ("zalo_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_teachers_zalo_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_teachers_zalo_uid"`);
    await queryRunner.query(
      `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "zalo_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "zalo_uid"`,
    );
  }
}
