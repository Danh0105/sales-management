import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWardToSuggest1787500000000 implements MigrationInterface {
  name = 'AddWardToSuggest1787500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "wardId" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_ward_id" ON "suggest" ("wardId")`,
    );
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "suggest"
          ADD CONSTRAINT "FK_suggest_ward_id"
          FOREIGN KEY ("wardId") REFERENCES "wards"("id")
          ON DELETE SET NULL;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "FK_suggest_ward_id"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_suggest_ward_id"`);
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "wardId"`,
    );
  }
}
