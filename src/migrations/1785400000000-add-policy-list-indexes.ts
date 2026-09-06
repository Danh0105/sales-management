import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Hỗ trợ API danh sách chính sách cho Director (GET /policies/admin/all):
 * - policy.updated_at: cột mới cho sortBy=updatedAt, backfill từ created_at.
 * - Index cho các cột lọc/sắp xếp: policy.status, policy.created_at,
 *   policy."subjectId", subjects.school_id, subjects.school_year,
 *   schools.employee_id.
 *
 * Runtime chạy synchronize:true nên cột/index được tạo tự động khi khởi động lại;
 * migration này dành cho môi trường tắt synchronize và để backfill updated_at
 * đúng bằng created_at thay vì now().
 */
export class AddPolicyListIndexes1785400000000 implements MigrationInterface {
    name = 'AddPolicyListIndexes1785400000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
      ALTER TABLE "policy"
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP NOT NULL DEFAULT now()
    `);

        // Bản ghi cũ chưa từng được sửa: updated_at = created_at.
        await queryRunner.query(`
      UPDATE "policy" SET "updated_at" = "created_at" WHERE "updated_at" > "created_at"
    `);

        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_policy_status" ON "policy" ("status")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_policy_created_at" ON "policy" ("created_at")`,
        );
        // Composite cho truy vấn phổ biến nhất: lọc status + sắp xếp created_at DESC.
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_policy_status_created_at" ON "policy" ("status", "created_at")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_policy_subject_id" ON "policy" ("subjectId")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_subjects_school_id" ON "subjects" ("school_id")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_subjects_school_year" ON "subjects" ("school_year")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_schools_employee_id" ON "schools" ("employee_id")`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_schools_employee_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subjects_school_year"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subjects_school_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_policy_subject_id"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_policy_status_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_policy_created_at"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_policy_status"`);
        await queryRunner.query(`ALTER TABLE "policy" DROP COLUMN IF EXISTS "updated_at"`);
    }
}
