import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nhiều hợp đồng PDF cho một chính sách. Chuyển dữ liệu cũ (một file trong
 * các cột `contract_*`) thành phần tử đầu tiên của mảng để không mất gì.
 */
export class AddPolicyContractFiles1789300000000 implements MigrationInterface {
  name = 'AddPolicyContractFiles1789300000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "policy" ADD COLUMN IF NOT EXISTS "contract_files" jsonb`,
    );
    await queryRunner.query(`
      UPDATE "policy"
      SET "contract_files" = jsonb_build_array(jsonb_build_object(
        'id', md5("contract_file_url"),
        'url', "contract_file_url",
        'originalName', COALESCE("contract_file_name", 'contract.pdf'),
        'size', 0,
        'uploadedById', "contract_uploaded_by_id",
        'uploadedByName', "contract_uploaded_by_name",
        'uploadedAt', COALESCE("contract_uploaded_at", now())
      ))
      WHERE "contract_file_url" IS NOT NULL
        AND ("contract_files" IS NULL OR jsonb_array_length("contract_files") = 0)
    `);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "policy" DROP COLUMN IF EXISTS "contract_files"`);
  }
}
