import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTeacherAvatarUrl1786700000000 implements MigrationInterface {
  name = 'AddTeacherAvatarUrl1786700000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "avatar_url" varchar(500)`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "avatar_url"`,
    );
  }
}
