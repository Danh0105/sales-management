import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEmployeeAvatarUrl1789200000000 implements MigrationInterface {
  name = 'AddEmployeeAvatarUrl1789200000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "employee" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500)`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "employee" DROP COLUMN IF EXISTS "avatar_url"`,
    );
  }
}
