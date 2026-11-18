import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tổng hợp thu chi — `cash_day_closings`: chốt quỹ ngày (End of Day hoặc tự
 * động sau 0h), lưu ảnh số dư từng tài khoản. Mỗi ngày chỉ một dòng CLOSED
 * (index duy nhất có điều kiện). Bảng mới, không đụng dữ liệu cũ.
 */
export class AddCashDayClosings1795200000000 implements MigrationInterface {
  name = 'AddCashDayClosings1795200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "cash_day_closings" (
        "id" SERIAL NOT NULL,
        "closing_date" date NOT NULL,
        "status" character varying(10) NOT NULL DEFAULT 'CLOSED',
        "mode" character varying(10) NOT NULL,
        "balances" jsonb NOT NULL,
        "line_count" integer NOT NULL,
        "closed_by" integer,
        "closed_by_name" character varying(255),
        "closed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reopened_by" integer,
        "reopened_by_name" character varying(255),
        "reopened_at" TIMESTAMP WITH TIME ZONE,
        "reopen_reason" text,
        CONSTRAINT "CHK_cash_day_closings_status" CHECK ("status" IN ('CLOSED','REOPENED')),
        CONSTRAINT "CHK_cash_day_closings_mode" CHECK ("mode" IN ('MANUAL','AUTO')),
        CONSTRAINT "PK_cash_day_closings" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_cash_day_closings_closed_date" ON "cash_day_closings" ("closing_date") WHERE "status" = 'CLOSED'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cash_day_closings"`);
  }
}
