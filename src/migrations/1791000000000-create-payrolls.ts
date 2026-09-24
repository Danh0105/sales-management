import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phiếu lương nhân viên theo tháng. Runtime hiện còn `synchronize: true`;
 * migration này dùng cho môi trường production khi tắt đồng bộ schema tự động.
 */
export class CreatePayrolls1791000000000 implements MigrationInterface {
  name = 'CreatePayrolls1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payrolls" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "employee_name" character varying(255) NOT NULL,
        "job_title" character varying(255),
        "month" smallint NOT NULL,
        "year" smallint NOT NULL,
        "standard_working_days" numeric(7,2) NOT NULL DEFAULT 0,
        "probation_working_days" numeric(7,2) NOT NULL DEFAULT 0,
        "official_working_days" numeric(7,2) NOT NULL DEFAULT 0,
        "annual_leave_days" numeric(7,2) NOT NULL DEFAULT 0,
        "holiday_days" numeric(7,2) NOT NULL DEFAULT 0,
        "unpaid_leave_days" numeric(7,2) NOT NULL DEFAULT 0,
        "leave_note" text,
        "excess_periods" numeric(7,2) NOT NULL DEFAULT 0,
        "remaining_leave_previous_year" numeric(7,2) NOT NULL DEFAULT 0,
        "remaining_leave_current_year" numeric(7,2) NOT NULL DEFAULT 0,
        "base_salary" numeric(15,2) NOT NULL DEFAULT 0,
        "official_work_salary" numeric(15,2) NOT NULL DEFAULT 0,
        "probation_work_salary" numeric(15,2) NOT NULL DEFAULT 0,
        "fuel_allowance" numeric(15,2) NOT NULL DEFAULT 0,
        "overtime_allowance" numeric(15,2) NOT NULL DEFAULT 0,
        "excess_period_allowance" numeric(15,2) NOT NULL DEFAULT 0,
        "other_support" numeric(15,2) NOT NULL DEFAULT 0,
        "bonus" numeric(15,2) NOT NULL DEFAULT 0,
        "total_income" numeric(15,2) NOT NULL DEFAULT 0,
        "social_insurance" numeric(15,2) NOT NULL DEFAULT 0,
        "personal_income_tax" numeric(15,2) NOT NULL DEFAULT 0,
        "adjustment_amount" numeric(15,2) NOT NULL DEFAULT 0,
        "adjustment_note" text,
        "advance_payment" numeric(15,2) NOT NULL DEFAULT 0,
        "total_deduction" numeric(15,2) NOT NULL DEFAULT 0,
        "net_salary" numeric(15,2) NOT NULL DEFAULT 0,
        "note" text,
        "created_by_id" integer NOT NULL,
        "created_by_name" character varying(255),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payrolls" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_payroll_employee_period" UNIQUE ("employee_id", "year", "month"),
        CONSTRAINT "CHK_payroll_month" CHECK ("month" BETWEEN 1 AND 12),
        CONSTRAINT "CHK_payroll_year" CHECK ("year" BETWEEN 2000 AND 2100),
        CONSTRAINT "FK_payroll_employee" FOREIGN KEY ("employee_id")
          REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_payroll_period"
      ON "payrolls" ("year", "month")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_payroll_period"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payrolls"`);
  }
}
