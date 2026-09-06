import { MigrationInterface, QueryRunner } from 'typeorm';

export class MapExpenseRequestSchoolYear1783036800000 implements MigrationInterface {
  name = 'MapExpenseRequestSchoolYear1783036800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "school_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "school_year" varchar(20)`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_attribute a
            ON a.attrelid = c.conrelid
           AND a.attnum = ANY(c.conkey)
          WHERE c.conrelid = 'suggest'::regclass
            AND c.contype = 'f'
            AND a.attname = 'school_id'
        ) THEN
          ALTER TABLE "suggest"
          ADD CONSTRAINT "FK_suggest_expense_school"
          FOREIGN KEY ("school_id") REFERENCES "schools"("id")
          ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_suggest_expense_school_year_status"
      ON "suggest" ("type", "school_id", "school_year", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_suggest_expense_school_year_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "FK_suggest_expense_school"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "school_year"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "school_id"`,
    );
  }
}
