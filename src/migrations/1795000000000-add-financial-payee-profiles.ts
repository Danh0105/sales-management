import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề nghị tài chính — `financial_payee_profiles`: thông tin nhận tiền mỗi
 * nhân viên lưu lại để điền sẵn cho đề nghị sau (khoá chính = employee_id).
 * Bảng mới, không đụng dữ liệu cũ; `IF NOT EXISTS` để chạy lại an toàn.
 */
export class AddFinancialPayeeProfiles1795000000000
  implements MigrationInterface
{
  name = 'AddFinancialPayeeProfiles1795000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "financial_payee_profiles" (
        "employee_id" integer NOT NULL,
        "payee_name" character varying(255),
        "bank_account_holder" character varying(255),
        "bank_name" character varying(255),
        "bank_account_number" character varying(50),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_financial_payee_profiles" PRIMARY KEY ("employee_id")
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "financial_payee_profiles"`);
  }
}
