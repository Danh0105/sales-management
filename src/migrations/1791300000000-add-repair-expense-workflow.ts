import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hoàn thiện luồng đề xuất sửa chữa cho môi trường đã tắt synchronize.
 * `ADD VALUE IF NOT EXISTS` giúp migration chạy an toàn cả khi synchronize đã
 * cập nhật enum trước đó.
 */
export class AddRepairExpenseWorkflow1791300000000
  implements MigrationInterface
{
  name = 'AddRepairExpenseWorkflow1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_request_kind_enum" ADD VALUE IF NOT EXISTS 'REPAIR'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'REPAIR_ACCEPTED'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'REPAIR_REJECTED'`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ALTER COLUMN "request_kind" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ALTER COLUMN "request_kind" DROP NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "assigned_technician_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "technical_responded_by" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "technical_responded_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "technical_reject_reason" text`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_assigned_technician" ON "suggest" ("assigned_technician_id")`,
    );

    const foreignKey = await queryRunner.query(`
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'FK_suggest_assigned_technician'
    `);
    if (!foreignKey.length) {
      await queryRunner.query(`
        ALTER TABLE "suggest"
        ADD CONSTRAINT "FK_suggest_assigned_technician"
        FOREIGN KEY ("assigned_technician_id") REFERENCES "employee"("id")
        ON DELETE SET NULL
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "FK_suggest_assigned_technician"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_suggest_assigned_technician"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "technical_reject_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "technical_responded_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "technical_responded_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "assigned_technician_id"`,
    );
    await queryRunner.query(
      `UPDATE "suggest" SET "request_kind" = 'CASH' WHERE "request_kind" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ALTER COLUMN "request_kind" SET DEFAULT 'CASH'`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ALTER COLUMN "request_kind" SET NOT NULL`,
    );
    // PostgreSQL không hỗ trợ xoá riêng một enum value an toàn. Giữ lại các
    // value mới để rollback không phải rebuild enum và cast toàn bảng.
  }
}
