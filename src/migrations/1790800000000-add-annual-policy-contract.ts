import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAnnualPolicyContract1790800000000 implements MigrationInterface {
    name = 'AddAnnualPolicyContract1790800000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "annual_policy"
            ADD COLUMN IF NOT EXISTS "contract_file_url" character varying,
            ADD COLUMN IF NOT EXISTS "contract_file_name" character varying,
            ADD COLUMN IF NOT EXISTS "contract_uploaded_by_id" integer,
            ADD COLUMN IF NOT EXISTS "contract_uploaded_by_name" character varying,
            ADD COLUMN IF NOT EXISTS "contract_uploaded_at" TIMESTAMP WITH TIME ZONE
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "annual_policy"
            DROP COLUMN IF EXISTS "contract_uploaded_at",
            DROP COLUMN IF EXISTS "contract_uploaded_by_name",
            DROP COLUMN IF EXISTS "contract_uploaded_by_id",
            DROP COLUMN IF EXISTS "contract_file_name",
            DROP COLUMN IF EXISTS "contract_file_url"
        `);
    }
}
