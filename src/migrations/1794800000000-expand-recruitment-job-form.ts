import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Mở rộng tin tuyển dụng cho form HR v2. Không xoá/đổi tên cột cũ; bản ghi cũ
 * giữ form_version=1 để vẫn công bố được theo contract trước đây.
 */
export class ExpandRecruitmentJobForm1794800000000 implements MigrationInterface {
  name = 'ExpandRecruitmentJobForm1794800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ['SEASONAL', 'REMOTE', 'HYBRID']) {
      await queryRunner.query(
        `ALTER TYPE "public"."recruitment_jobs_employment_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE "recruitment_jobs"
        ADD COLUMN IF NOT EXISTS "industry_ids" integer array NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS "seniority" character varying(30),
        ADD COLUMN IF NOT EXISTS "experience_level" character varying(30),
        ADD COLUMN IF NOT EXISTS "application_deadline" date,
        ADD COLUMN IF NOT EXISTS "salary_negotiable" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "salary_structure" character varying(30),
        ADD COLUMN IF NOT EXISTS "benefits" text,
        ADD COLUMN IF NOT EXISTS "education_level" character varying(30),
        ADD COLUMN IF NOT EXISTS "probation_period" character varying(100),
        ADD COLUMN IF NOT EXISTS "work_locations" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS "allow_applications_without_cv" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "contact_name" character varying(255),
        ADD COLUMN IF NOT EXISTS "contact_email" character varying(255),
        ADD COLUMN IF NOT EXISTS "contact_phone" character varying(20),
        ADD COLUMN IF NOT EXISTS "additional_phones" text array NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS "form_version" smallint NOT NULL DEFAULT 1
    `);
    await queryRunner.query(`
      UPDATE "recruitment_jobs"
      SET "salary_negotiable" = true
      WHERE "salary_min" IS NULL AND "salary_max" IS NULL
    `);
    await queryRunner.query(`
      UPDATE "recruitment_jobs"
      SET "industry_ids" = ARRAY["department_id"]
      WHERE "department_id" IS NOT NULL AND cardinality("industry_ids") = 0
    `);
    await queryRunner.query(
      `ALTER TABLE "recruitment_jobs" ALTER COLUMN "form_version" SET DEFAULT 2`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "recruitment_jobs"
        DROP COLUMN IF EXISTS "form_version",
        DROP COLUMN IF EXISTS "additional_phones",
        DROP COLUMN IF EXISTS "contact_phone",
        DROP COLUMN IF EXISTS "contact_email",
        DROP COLUMN IF EXISTS "contact_name",
        DROP COLUMN IF EXISTS "allow_applications_without_cv",
        DROP COLUMN IF EXISTS "work_locations",
        DROP COLUMN IF EXISTS "probation_period",
        DROP COLUMN IF EXISTS "education_level",
        DROP COLUMN IF EXISTS "benefits",
        DROP COLUMN IF EXISTS "salary_structure",
        DROP COLUMN IF EXISTS "salary_negotiable",
        DROP COLUMN IF EXISTS "application_deadline",
        DROP COLUMN IF EXISTS "experience_level",
        DROP COLUMN IF EXISTS "seniority",
        DROP COLUMN IF EXISTS "industry_ids"
    `);
    // PostgreSQL không hỗ trợ xoá an toàn từng giá trị enum khi cột còn tồn tại.
  }
}
