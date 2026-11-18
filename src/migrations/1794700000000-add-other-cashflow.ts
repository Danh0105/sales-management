import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * THU CHI NGOÀI (tab trong Chính sách): hợp đồng thu/chi khác do NV kinh
 * doanh lập, giám đốc duyệt, thủ quỹ ghi nhận nhiều lần. Thu khác hình thức
 * Thương mại có dòng hàng + chi phí và đi luồng công nợ (kế toán công nợ lập
 * phiếu thu / lệnh chi, thủ quỹ thu/chi theo phiếu). 7 bảng mới
 * `other_cashflow_*`, KHÔNG sửa bảng cũ nào (thông báo dùng loại POLICY có sẵn).
 *
 * DDL sinh từ entity bằng schema builder của TypeORM rồi chép nguyên văn, để
 * `synchronize` (nếu có ai bật) không thấy khác biệt.
 *
 * Chạy lại an toàn: đã có đủ các bảng thì bỏ qua; chỉ có một phần thì dừng để
 * kiểm tra tay.
 */
export class AddOtherCashflow1794700000000 implements MigrationInterface {
  name = 'AddOtherCashflow1794700000000';

  private static readonly TABLES = [
    'other_cashflow_contracts',
    'other_cashflow_items',
    'other_cashflow_costs',
    'other_cashflow_orders',
    'other_cashflow_entries',
    'other_cashflow_attachments',
    'other_cashflow_events',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing: { name: string }[] = await queryRunner.query(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [AddOtherCashflow1794700000000.TABLES],
    );
    if (existing.length === AddOtherCashflow1794700000000.TABLES.length) return;
    if (existing.length > 0) {
      throw new Error(
        `other_cashflow_* chỉ có ${existing.length}/${AddOtherCashflow1794700000000.TABLES.length} bảng — dừng để kiểm tra tay`,
      );
    }

    await queryRunner.query(
      `CREATE TABLE "other_cashflow_contracts" ("id" SERIAL NOT NULL, "direction" character varying(10) NOT NULL, "form" character varying(20) NOT NULL DEFAULT 'STANDARD', "title" character varying(255) NOT NULL, "document_no" character varying(100), "partner_name" character varying(255) NOT NULL, "school_id" integer, "amount" bigint NOT NULL, "signed_date" date, "expected_date" date, "note" text, "status" character varying(20) NOT NULL DEFAULT 'PENDING', "recorded_amount" bigint NOT NULL DEFAULT '0', "cost_amount" bigint NOT NULL DEFAULT '0', "paid_cost_amount" bigint NOT NULL DEFAULT '0', "created_by_id" integer NOT NULL, "created_by_name" character varying(255), "submitted_at" TIMESTAMP WITH TIME ZONE NOT NULL, "reviewed_by_id" integer, "reviewed_by_name" character varying(255), "reviewed_at" TIMESTAMP WITH TIME ZONE, "review_note" text, "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancel_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_other_cashflow_contracts_recorded" CHECK ("recorded_amount" >= 0 AND "recorded_amount" <= "amount"), CONSTRAINT "CHK_other_cashflow_contracts_costs" CHECK ("cost_amount" >= 0 AND "paid_cost_amount" >= 0 AND "paid_cost_amount" <= "cost_amount"), CONSTRAINT "CHK_other_cashflow_contracts_form" CHECK ("form" IN ('STANDARD','COMMERCIAL') AND ("form" = 'STANDARD' OR "direction" = 'IN')), CONSTRAINT "CHK_other_cashflow_contracts_amount" CHECK ("amount" > 0), CONSTRAINT "CHK_other_cashflow_contracts_status" CHECK ("status" IN ('PENDING','REJECTED','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED')), CONSTRAINT "CHK_other_cashflow_contracts_direction" CHECK ("direction" IN ('IN','OUT')), CONSTRAINT "PK_other_cashflow_contracts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_contracts_created_by" ON "other_cashflow_contracts" ("created_by_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_contracts_status" ON "other_cashflow_contracts" ("status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_costs" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "line_no" integer NOT NULL, "description" character varying(255) NOT NULL, "payee" character varying(255), "amount" bigint NOT NULL, "paid_amount" bigint NOT NULL DEFAULT '0', CONSTRAINT "CHK_other_cashflow_costs_amounts" CHECK ("amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "amount"), CONSTRAINT "PK_other_cashflow_costs" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_costs_contract" ON "other_cashflow_costs" ("contract_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_orders" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "kind" character varying(20) NOT NULL, "cost_id" integer, "amount" bigint NOT NULL, "due_date" date, "note" text, "status" character varying(20) NOT NULL DEFAULT 'PENDING', "created_by_id" integer NOT NULL, "created_by_name" character varying(255), "cancelled_at" TIMESTAMP WITH TIME ZONE, "cancelled_by_name" character varying(255), "cancel_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_other_cashflow_orders_status" CHECK ("status" IN ('PENDING','EXECUTED','CANCELLED')), CONSTRAINT "CHK_other_cashflow_orders_kind" CHECK (("kind" = 'RECEIPT' AND "cost_id" IS NULL) OR ("kind" = 'PAYMENT' AND "cost_id" IS NOT NULL)), CONSTRAINT "CHK_other_cashflow_orders_amount" CHECK ("amount" > 0), CONSTRAINT "PK_other_cashflow_orders" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_orders_contract" ON "other_cashflow_orders" ("contract_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_items" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "line_no" integer NOT NULL, "item_code" character varying(50) NOT NULL, "item_name" character varying(255) NOT NULL, "unit" character varying(30), "quantity" numeric(15,4) NOT NULL, "unit_price" numeric(18,2) NOT NULL, "amount" bigint NOT NULL, CONSTRAINT "CHK_other_cashflow_items_values" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "amount" >= 0), CONSTRAINT "PK_other_cashflow_items" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_items_contract" ON "other_cashflow_items" ("contract_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_events" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "action" character varying(40) NOT NULL, "from_status" character varying(20), "to_status" character varying(20), "actor_id" integer, "actor_name" character varying(255), "note" text, "changes" jsonb, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_other_cashflow_events" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_events_contract" ON "other_cashflow_events" ("contract_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_entries" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "flow" character varying(10) NOT NULL, "order_id" integer, "cost_id" integer, "entry_date" date NOT NULL, "amount" bigint NOT NULL, "cash_account_code" character varying(20) NOT NULL, "note" text, "idempotency_key" character varying(100) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'RECORDED', "recorded_by_id" integer NOT NULL, "recorded_by_name" character varying(255), "voided_at" TIMESTAMP WITH TIME ZONE, "voided_by_id" integer, "voided_by_name" character varying(255), "void_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_other_cashflow_entries_idempotency" UNIQUE ("idempotency_key"), CONSTRAINT "CHK_other_cashflow_entries_flow" CHECK ("flow" IN ('IN','OUT')), CONSTRAINT "CHK_other_cashflow_entries_status" CHECK ("status" IN ('RECORDED','VOIDED')), CONSTRAINT "CHK_other_cashflow_entries_amount" CHECK ("amount" > 0), CONSTRAINT "PK_other_cashflow_entries" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_entries_contract" ON "other_cashflow_entries" ("contract_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "other_cashflow_attachments" ("id" SERIAL NOT NULL, "contract_id" integer NOT NULL, "entry_id" integer, "kind" character varying(20) NOT NULL, "storage_path" character varying(500) NOT NULL, "original_name" character varying(255) NOT NULL, "mime_type" character varying(100) NOT NULL, "size_bytes" integer NOT NULL, "sha256" character varying(64) NOT NULL, "uploaded_by_id" integer NOT NULL, "uploaded_by_name" character varying(255), "deleted_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_other_cashflow_attachments_kind" CHECK ("kind" IN ('CONTRACT','EVIDENCE')), CONSTRAINT "PK_other_cashflow_attachments" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_other_cashflow_attachments_contract" ON "other_cashflow_attachments" ("contract_id") `,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_contracts" ADD CONSTRAINT "FK_other_cashflow_contracts_school" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_costs" ADD CONSTRAINT "FK_other_cashflow_costs_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_orders" ADD CONSTRAINT "FK_other_cashflow_orders_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_orders" ADD CONSTRAINT "FK_other_cashflow_orders_cost" FOREIGN KEY ("cost_id") REFERENCES "other_cashflow_costs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_items" ADD CONSTRAINT "FK_other_cashflow_items_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_events" ADD CONSTRAINT "FK_other_cashflow_events_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_entries" ADD CONSTRAINT "FK_other_cashflow_entries_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_entries" ADD CONSTRAINT "FK_other_cashflow_entries_order" FOREIGN KEY ("order_id") REFERENCES "other_cashflow_orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_entries" ADD CONSTRAINT "FK_other_cashflow_entries_cost" FOREIGN KEY ("cost_id") REFERENCES "other_cashflow_costs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_attachments" ADD CONSTRAINT "FK_other_cashflow_attachments_contract" FOREIGN KEY ("contract_id") REFERENCES "other_cashflow_contracts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "other_cashflow_attachments" ADD CONSTRAINT "FK_other_cashflow_attachments_entry" FOREIGN KEY ("entry_id") REFERENCES "other_cashflow_entries"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Mất toàn bộ hợp đồng/ghi nhận Thu Chi ngoài — chỉ chạy khi gỡ tính năng.
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_attachments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_entries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_orders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_costs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "other_cashflow_contracts"`);
  }
}
