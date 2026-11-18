import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề nghị tài chính — `financial_employee_companies`: nhân viên thuộc công ty
 * nào (một công ty/người, khoá chính = employee_id), xếp ở màn Phân quyền cùng
 * phòng ban. Dùng để chọn sẵn công ty khi nhân viên lập đề nghị.
 * Bảng mới, không đụng dữ liệu cũ; `IF NOT EXISTS` để chạy lại an toàn.
 */
export class AddFinancialEmployeeCompanies1795800000000
  implements MigrationInterface
{
  name = 'AddFinancialEmployeeCompanies1795800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "financial_employee_companies" (
        "employee_id" integer NOT NULL,
        "company_id" integer NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_financial_employee_companies" PRIMARY KEY ("employee_id"),
        CONSTRAINT "FK_financial_employee_companies_company" FOREIGN KEY ("company_id")
          REFERENCES "financial_companies"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_financial_employee_companies_company"
        ON "financial_employee_companies" ("company_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "financial_employee_companies"`,
    );
  }
}
