import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề xuất thiết bị mua từ nhà cung cấp (equipment_source = SUPPLIER): Giám
 * đốc lập phiếu nhập kho dự kiến + chỉ định người xử lý và người nghiệm thu
 * khi duyệt. Kèm bảng giao việc (người bàn giao + người hỗ trợ, có thể từ
 * chối và được thay người).
 */
export class AddSupplierEquipmentWorkflow1791500000000
  implements MigrationInterface
{
  name = 'AddSupplierEquipmentWorkflow1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."suggest_status_enum" ADD VALUE IF NOT EXISTS 'STOCK_IN_COMPLETED'`,
    );

    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "equipment_source" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "stock_in_handler_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" ADD COLUMN IF NOT EXISTS "acceptor_id" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_stock_in_handler" ON "suggest" ("stock_in_handler_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_acceptor" ON "suggest" ("acceptor_id")`,
    );

    for (const [name, column] of [
      ['FK_suggest_stock_in_handler', 'stock_in_handler_id'],
      ['FK_suggest_acceptor', 'acceptor_id'],
    ]) {
      const exists = await queryRunner.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1`,
        [name],
      );
      if (!exists.length) {
        await queryRunner.query(`
          ALTER TABLE "suggest"
          ADD CONSTRAINT "${name}"
          FOREIGN KEY ("${column}") REFERENCES "employee"("id")
          ON DELETE SET NULL
        `);
      }
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "suggest_stock_in_order" (
        "id" SERIAL PRIMARY KEY,
        "code" character varying NOT NULL UNIQUE,
        "suggestId" integer NOT NULL UNIQUE
          REFERENCES "suggest"("id") ON DELETE CASCADE,
        "draft_items" jsonb NOT NULL,
        "draft_note" text,
        "createdBy" integer NOT NULL REFERENCES "employee"("id"),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "items" jsonb,
        "note" text,
        "warehouse_receipt_id" integer
          REFERENCES "warehouse_receipt"("id") ON DELETE SET NULL,
        "stocked_by" integer REFERENCES "employee"("id"),
        "stocked_at" TIMESTAMP WITH TIME ZONE
      )
    `);

    // Người bàn giao + người hỗ trợ của đề xuất thiết bị/sửa chữa.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "suggest_assignment" (
        "id" SERIAL PRIMARY KEY,
        "suggestId" integer NOT NULL
          REFERENCES "suggest"("id") ON DELETE CASCADE,
        "employeeId" integer NOT NULL
          REFERENCES "employee"("id") ON DELETE CASCADE,
        "role" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'ASSIGNED',
        "decline_reason" text,
        "declined_at" TIMESTAMP WITH TIME ZONE,
        "replaced_by_id" integer,
        "assigned_by" integer NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_assignment_suggest_status" ON "suggest_assignment" ("suggestId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_assignment_employee_status" ON "suggest_assignment" ("employeeId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "suggest_assignment"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "suggest_stock_in_order"`);
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "FK_suggest_acceptor"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP CONSTRAINT IF EXISTS "FK_suggest_stock_in_handler"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_suggest_acceptor"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_suggest_stock_in_handler"`,
    );
    await queryRunner.query(`ALTER TABLE "suggest" DROP COLUMN IF EXISTS "acceptor_id"`);
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "stock_in_handler_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suggest" DROP COLUMN IF EXISTS "equipment_source"`,
    );
    // Giữ lại enum value STOCK_IN_COMPLETED — như migration sửa chữa.
  }
}
