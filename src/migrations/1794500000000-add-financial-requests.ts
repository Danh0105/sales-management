import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phân hệ ĐỀ NGHỊ TÀI CHÍNH NỘI BỘ (tạm ứng, tạm ứng lương, hoàn ứng, thanh
 * toán chi phí): 17 bảng `financial_*` mới, KHÔNG sửa bảng cũ nào ngoài việc
 * thêm một giá trị vào enum loại thông báo.
 *
 * - DDL bảng sinh từ entity bằng schema builder của TypeORM rồi chép nguyên
 *   văn, để `synchronize` (nếu có ai bật) không thấy khác biệt.
 * - Nhật ký `financial_audit_logs` bất biến: trigger chặn UPDATE/DELETE.
 * - Mỗi phạm vi (công ty × loại chứng từ) chỉ một quy trình đang hoạt động.
 * - Dữ liệu mặc định: danh mục chi phí chung, chính sách GLOBAL, một quy trình
 *   4 cấp mặc định (Quản lý trực tiếp → Kiểm soát → Kế toán → BGĐ/TP). Không
 *   tạo công ty, nhân viên hay tài khoản ngân hàng nào.
 *
 * Chạy lại an toàn: bảng đã có đủ thì bỏ qua phần tạo bảng; seed dùng
 * `ON CONFLICT DO NOTHING` / kiểm tra tồn tại.
 */
export class AddFinancialRequests1794500000000 implements MigrationInterface {
  name = 'AddFinancialRequests1794500000000';

  private static readonly TABLES = [
    'financial_companies',
    'financial_expense_categories',
    'financial_approval_workflows',
    'financial_workflow_steps',
    'financial_role_assignments',
    'financial_approval_delegations',
    'financial_policies',
    'financial_document_sequences',
    'financial_requests',
    'financial_request_items',
    'financial_approval_steps',
    'financial_payments',
    'financial_refunds',
    'financial_request_attachments',
    'financial_advance_allocations',
    'financial_salary_advance_deductions',
    'financial_audit_logs',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing: { name: string }[] = await queryRunner.query(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [AddFinancialRequests1794500000000.TABLES],
    );
    if (existing.length === 0) {
      await this.createTables(queryRunner);
      await this.createExtras(queryRunner);
    } else if (
      existing.length !== AddFinancialRequests1794500000000.TABLES.length
    ) {
      throw new Error(
        `financial_* chỉ có ${existing.length}/${AddFinancialRequests1794500000000.TABLES.length} bảng — dừng để kiểm tra tay`,
      );
    }

    await queryRunner.query(
      `ALTER TYPE "public"."notification_type_enum" ADD VALUE IF NOT EXISTS 'FINANCIAL_REQUEST'`,
    );
    await this.seed(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Giá trị enum thông báo không gỡ được an toàn trong Postgres — để lại.
    for (const table of [
      ...AddFinancialRequests1794500000000.TABLES,
    ].reverse()) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS "financial_audit_logs_immutable"()`,
    );
  }

  private async createTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "financial_companies" (
        "id" SERIAL NOT NULL,
        "code" character varying(30) NOT NULL,
        "name" character varying(255) NOT NULL,
        "short_name" character varying(100),
        "tax_code" character varying(30),
        "address" character varying(500),
        "phone" character varying(50),
        "email" character varying(255),
        "logo_path" character varying(500),
        "form_codes" jsonb NOT NULL DEFAULT '{}',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_companies_code" UNIQUE ("code"),
        CONSTRAINT "PK_financial_companies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_approval_workflows" (
        "id" SERIAL NOT NULL,
        "name" character varying(255) NOT NULL,
        "company_id" integer,
        "request_type" character varying(30),
        "is_active" boolean NOT NULL DEFAULT true,
        "is_sequential" boolean NOT NULL DEFAULT true,
        "self_approval_mode" character varying(20) NOT NULL DEFAULT 'BLOCK',
        "allow_withdraw" boolean NOT NULL DEFAULT true,
        "description" text,
        "created_by_id" integer,
        "updated_by_id" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_financial_approval_workflows_self" CHECK ("self_approval_mode" IN ('BLOCK','SKIP_STEP','ALLOW')),
        CONSTRAINT "CHK_financial_approval_workflows_type" CHECK ("request_type" IS NULL OR "request_type" IN ('ADVANCE','SALARY_ADVANCE','SETTLEMENT','EXPENSE_PAYMENT')),
        CONSTRAINT "PK_financial_approval_workflows" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_workflow_steps" (
        "id" SERIAL NOT NULL,
        "workflow_id" integer NOT NULL,
        "step_order" integer NOT NULL,
        "name" character varying(255) NOT NULL,
        "signature_slot" character varying(20),
        "approver_type" character varying(20) NOT NULL,
        "approver_role" character varying(20),
        "approver_employee_id" integer,
        "min_amount" bigint,
        "can_adjust_amounts" boolean NOT NULL DEFAULT false,
        "skippable" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_workflow_steps_order" UNIQUE ("workflow_id", "step_order"),
        CONSTRAINT "CHK_financial_workflow_steps_slot" CHECK ("signature_slot" IS NULL OR "signature_slot" IN ('MANAGER','CONTROLLER','ACCOUNTANT','DIRECTOR')),
        CONSTRAINT "CHK_financial_workflow_steps_role" CHECK ("approver_role" IS NULL OR "approver_role" IN ('MANAGER','CONTROLLER','ACCOUNTANT','CASHIER','DIRECTOR','ADMIN','VIEWER')),
        CONSTRAINT "CHK_financial_workflow_steps_approver" CHECK ("approver_type" IN ('DIRECT_MANAGER','ROLE','EMPLOYEE')),
        CONSTRAINT "PK_financial_workflow_steps" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_approval_steps" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "round" smallint NOT NULL,
        "step_order" smallint NOT NULL,
        "name" character varying(255) NOT NULL,
        "signature_slot" character varying(20),
        "approver_type" character varying(20) NOT NULL,
        "approver_role" character varying(20),
        "approver_employee_id" integer,
        "min_amount" bigint,
        "can_adjust_amounts" boolean NOT NULL DEFAULT false,
        "skippable" boolean NOT NULL DEFAULT false,
        "candidate_approver_ids" integer array NOT NULL DEFAULT '{}',
        "status" character varying(20) NOT NULL,
        "acted_by_id" integer,
        "acted_by_name" character varying(255),
        "on_behalf_of_id" integer,
        "on_behalf_of_name" character varying(255),
        "acted_at" TIMESTAMP WITH TIME ZONE,
        "comment" text,
        "activated_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_approval_steps_order" UNIQUE ("request_id", "round", "step_order"),
        CONSTRAINT "CHK_financial_approval_steps_status" CHECK ("status" IN ('WAITING','PENDING','APPROVED','REJECTED','RETURNED','SKIPPED','CANCELLED')),
        CONSTRAINT "PK_financial_approval_steps" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_expense_categories" (
        "id" SERIAL NOT NULL,
        "code" character varying(50) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" text,
        "limit_amount" bigint,
        "sort_order" integer NOT NULL DEFAULT '0',
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_expense_categories_code" UNIQUE ("code"),
        CONSTRAINT "PK_financial_expense_categories" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_request_items" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "line_no" smallint NOT NULL,
        "description" character varying(500) NOT NULL,
        "category_id" integer,
        "category_name" character varying(255),
        "unit" character varying(50),
        "quantity" numeric(15,4) NOT NULL,
        "unit_price" numeric(18,2) NOT NULL,
        "amount" bigint NOT NULL,
        "approved_amount" bigint,
        "adjustment_reason" text,
        "adjusted_by_id" integer,
        "adjusted_by_name" character varying(255),
        "adjusted_at" TIMESTAMP WITH TIME ZONE,
        "incurred_date" date,
        "invoice_number" character varying(100),
        "invoice_type" character varying(10),
        "supplier_name" character varying(255),
        "note" text,
        "over_limit" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_financial_request_items_invoice_type" CHECK ("invoice_type" IS NULL OR "invoice_type" IN ('VAT','NON_VAT','NONE')),
        CONSTRAINT "CHK_financial_request_items_amounts" CHECK ("quantity" >= 0 AND "unit_price" >= 0 AND "amount" >= 0 AND ("approved_amount" IS NULL OR "approved_amount" >= 0)),
        CONSTRAINT "PK_financial_request_items" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_requests" (
        "id" SERIAL NOT NULL,
        "code" character varying(30) NOT NULL,
        "type" character varying(30) NOT NULL,
        "company_id" integer NOT NULL,
        "requester_id" integer NOT NULL,
        "requester_name" character varying(255) NOT NULL,
        "requester_code" character varying(50),
        "requester_position" character varying(255),
        "department_id" integer,
        "department_name" character varying(255),
        "direct_manager_id" integer,
        "direct_manager_name" character varying(255),
        "request_date" date NOT NULL,
        "title" character varying(500) NOT NULL,
        "purpose" text,
        "project_name" character varying(255),
        "expected_use_date" date,
        "settlement_due_date" date,
        "location" character varying(255),
        "trip_start_date" date,
        "trip_end_date" date,
        "salary_year" smallint,
        "salary_month" smallint,
        "expected_salary" bigint,
        "deduction_start_year" smallint,
        "deduction_start_month" smallint,
        "deduction_periods" smallint,
        "payee_name" character varying(255),
        "bank_account_holder" character varying(255),
        "bank_name" character varying(255),
        "bank_account_number" character varying(50),
        "payment_method" character varying(20),
        "payment_note" text,
        "currency" character varying(3) NOT NULL DEFAULT 'VND',
        "total_amount" bigint NOT NULL DEFAULT '0',
        "approved_amount" bigint,
        "offset_amount" bigint NOT NULL DEFAULT '0',
        "paid_amount" bigint NOT NULL DEFAULT '0',
        "recovered_amount" bigint NOT NULL DEFAULT '0',
        "settled_amount" bigint NOT NULL DEFAULT '0',
        "deducted_amount" bigint NOT NULL DEFAULT '0',
        "approval_status" character varying(20) NOT NULL DEFAULT 'DRAFT',
        "payment_status" character varying(20) NOT NULL DEFAULT 'NONE',
        "recovery_status" character varying(20) NOT NULL DEFAULT 'NONE',
        "settlement_status" character varying(20) NOT NULL DEFAULT 'NONE',
        "deduction_status" character varying(20) NOT NULL DEFAULT 'NONE',
        "workflow_id" integer,
        "workflow_name" character varying(255),
        "is_sequential" boolean NOT NULL DEFAULT true,
        "current_round" smallint NOT NULL DEFAULT '0',
        "submitted_at" TIMESTAMP WITH TIME ZONE,
        "approved_at" TIMESTAMP WITH TIME ZONE,
        "rejected_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "cancelled_at" TIMESTAMP WITH TIME ZONE,
        "cancel_reason" text,
        "copied_from_id" integer,
        "version" integer NOT NULL DEFAULT '1',
        "created_by_id" integer NOT NULL,
        "created_by_name" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "UQ_financial_requests_code" UNIQUE ("code"),
        CONSTRAINT "CHK_financial_requests_salary_month" CHECK (("salary_month" IS NULL OR "salary_month" BETWEEN 1 AND 12) AND ("deduction_start_month" IS NULL OR "deduction_start_month" BETWEEN 1 AND 12)),
        CONSTRAINT "CHK_financial_requests_amounts" CHECK ("total_amount" >= 0 AND "offset_amount" >= 0 AND "paid_amount" >= 0 AND "recovered_amount" >= 0 AND "settled_amount" >= 0 AND "deducted_amount" >= 0 AND ("approved_amount" IS NULL OR "approved_amount" >= 0)),
        CONSTRAINT "CHK_financial_requests_payment_method" CHECK ("payment_method" IS NULL OR "payment_method" IN ('BANK_TRANSFER','CASH')),
        CONSTRAINT "CHK_financial_requests_deduction_status" CHECK ("deduction_status" IN ('NONE','NOT_DEDUCTED','DEDUCTING','DEDUCTED')),
        CONSTRAINT "CHK_financial_requests_settlement_status" CHECK ("settlement_status" IN ('NONE','NOT_SETTLED','PARTIALLY_SETTLED','SETTLED','PENDING_PAYMENT','PENDING_REFUND','COMPLETED')),
        CONSTRAINT "CHK_financial_requests_recovery_status" CHECK ("recovery_status" IN ('NONE','PENDING','PARTIAL','RECOVERED')),
        CONSTRAINT "CHK_financial_requests_payment_status" CHECK ("payment_status" IN ('NONE','UNPAID','PARTIALLY_PAID','PAID')),
        CONSTRAINT "CHK_financial_requests_approval_status" CHECK ("approval_status" IN ('DRAFT','PENDING','RETURNED','APPROVED','REJECTED','CANCELLED')),
        CONSTRAINT "CHK_financial_requests_type" CHECK ("type" IN ('ADVANCE','SALARY_ADVANCE','SETTLEMENT','EXPENSE_PAYMENT')),
        CONSTRAINT "PK_financial_requests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_salary_advance_deductions" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "employee_id" integer NOT NULL,
        "period_year" smallint NOT NULL,
        "period_month" smallint NOT NULL,
        "planned_amount" bigint NOT NULL,
        "deducted_amount" bigint,
        "status" character varying(20) NOT NULL DEFAULT 'PLANNED',
        "payroll_id" integer,
        "idempotency_key" character varying(100),
        "deducted_at" TIMESTAMP WITH TIME ZONE,
        "deducted_by_id" integer,
        "deducted_by_name" character varying(255),
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_salary_advance_deductions_idempotency" UNIQUE ("idempotency_key"),
        CONSTRAINT "UQ_financial_salary_advance_deductions_period" UNIQUE ("request_id", "period_year", "period_month"),
        CONSTRAINT "CHK_financial_salary_advance_deductions_amounts" CHECK ("planned_amount" >= 0 AND ("deducted_amount" IS NULL OR "deducted_amount" >= 0) AND "period_month" BETWEEN 1 AND 12),
        CONSTRAINT "CHK_financial_salary_advance_deductions_status" CHECK ("status" IN ('PLANNED','DEDUCTED','CANCELLED')),
        CONSTRAINT "PK_financial_salary_advance_deductions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_role_assignments" (
        "id" SERIAL NOT NULL,
        "employee_id" integer NOT NULL,
        "role" character varying(20) NOT NULL,
        "company_id" integer,
        "department_id" integer,
        "approval_limit" bigint,
        "is_active" boolean NOT NULL DEFAULT true,
        "note" character varying(500),
        "created_by_id" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_financial_role_assignments_role" CHECK ("role" IN ('MANAGER','CONTROLLER','ACCOUNTANT','CASHIER','DIRECTOR','ADMIN','VIEWER')),
        CONSTRAINT "PK_financial_role_assignments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_payments" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "amount" bigint NOT NULL,
        "paid_at" date NOT NULL,
        "method" character varying(20) NOT NULL,
        "cash_account_code" character varying(20),
        "transaction_ref" character varying(100),
        "note" text,
        "idempotency_key" character varying(100) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'RECORDED',
        "recorded_by_id" integer NOT NULL,
        "recorded_by_name" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "voided_at" TIMESTAMP WITH TIME ZONE,
        "voided_by_id" integer,
        "voided_by_name" character varying(255),
        "void_reason" text,
        CONSTRAINT "UQ_financial_payments_idempotency" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_financial_payments_method" CHECK ("method" IN ('BANK_TRANSFER','CASH')),
        CONSTRAINT "CHK_financial_payments_status" CHECK ("status" IN ('RECORDED','VOIDED')),
        CONSTRAINT "CHK_financial_payments_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_financial_payments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_refunds" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "amount" bigint NOT NULL,
        "received_at" date NOT NULL,
        "method" character varying(20) NOT NULL,
        "cash_account_code" character varying(20),
        "transaction_ref" character varying(100),
        "note" text,
        "idempotency_key" character varying(100) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'RECORDED',
        "recorded_by_id" integer NOT NULL,
        "recorded_by_name" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "voided_at" TIMESTAMP WITH TIME ZONE,
        "voided_by_id" integer,
        "voided_by_name" character varying(255),
        "void_reason" text,
        CONSTRAINT "UQ_financial_refunds_idempotency" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_financial_refunds_method" CHECK ("method" IN ('BANK_TRANSFER','CASH')),
        CONSTRAINT "CHK_financial_refunds_status" CHECK ("status" IN ('RECORDED','VOIDED')),
        CONSTRAINT "CHK_financial_refunds_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_financial_refunds" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_request_attachments" (
        "id" SERIAL NOT NULL,
        "request_id" integer NOT NULL,
        "item_id" integer,
        "payment_id" integer,
        "refund_id" integer,
        "kind" character varying(30) NOT NULL DEFAULT 'DOCUMENT',
        "storage_path" character varying(500) NOT NULL,
        "original_name" character varying(255) NOT NULL,
        "mime_type" character varying(100) NOT NULL,
        "size_bytes" integer NOT NULL,
        "sha256" character varying(64) NOT NULL,
        "uploaded_by_id" integer NOT NULL,
        "uploaded_by_name" character varying(255),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "deleted_by_id" integer,
        CONSTRAINT "CHK_financial_request_attachments_kind" CHECK ("kind" IN ('DOCUMENT','INVOICE','PAYMENT_PROOF','REFUND_PROOF','ADJUSTMENT_EVIDENCE')),
        CONSTRAINT "PK_financial_request_attachments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_policies" (
        "id" SERIAL NOT NULL,
        "scope_key" character varying(30) NOT NULL,
        "salary_advance_max_per_month" integer,
        "salary_advance_max_amount" bigint,
        "salary_advance_max_percent" numeric(5,2),
        "max_deduction_periods" integer NOT NULL DEFAULT '1',
        "advance_due_days" integer NOT NULL DEFAULT '30',
        "reminder_days_before" integer NOT NULL DEFAULT '3',
        "expense_over_limit_mode" character varying(10) NOT NULL DEFAULT 'WARN',
        "updated_by_id" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_policies_scope" UNIQUE ("scope_key"),
        CONSTRAINT "CHK_financial_policies_over_limit" CHECK ("expense_over_limit_mode" IN ('WARN','BLOCK')),
        CONSTRAINT "PK_financial_policies" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_document_sequences" (
        "prefix" character varying(10) NOT NULL,
        "year" smallint NOT NULL,
        "last_number" integer NOT NULL DEFAULT '0',
        CONSTRAINT "PK_financial_document_sequences" PRIMARY KEY ("prefix", "year")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_audit_logs" (
        "id" SERIAL NOT NULL,
        "request_id" integer,
        "entity_type" character varying(50) NOT NULL,
        "entity_id" integer,
        "action" character varying(50) NOT NULL,
        "from_status" character varying(20),
        "to_status" character varying(20),
        "actor_id" integer,
        "actor_name" character varying(255),
        "comment" text,
        "changes" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_financial_audit_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_approval_delegations" (
        "id" SERIAL NOT NULL,
        "delegator_id" integer NOT NULL,
        "delegate_id" integer NOT NULL,
        "company_id" integer,
        "request_type" character varying(30),
        "starts_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ends_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "reason" character varying(500),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_by_id" integer,
        "created_by_id" integer NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_financial_approval_delegations_people" CHECK ("delegator_id" <> "delegate_id"),
        CONSTRAINT "CHK_financial_approval_delegations_period" CHECK ("ends_at" > "starts_at"),
        CONSTRAINT "PK_financial_approval_delegations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "financial_advance_allocations" (
        "id" SERIAL NOT NULL,
        "settlement_id" integer NOT NULL,
        "advance_id" integer NOT NULL,
        "amount" bigint NOT NULL,
        "applied_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_financial_advance_allocations_pair" UNIQUE ("settlement_id", "advance_id"),
        CONSTRAINT "CHK_financial_advance_allocations_distinct" CHECK ("settlement_id" <> "advance_id"),
        CONSTRAINT "CHK_financial_advance_allocations_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_financial_advance_allocations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_approval_steps_status" ON "financial_approval_steps" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_request_items_request" ON "financial_request_items" ("request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_requests_type" ON "financial_requests" ("type")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_requests_approval_status" ON "financial_requests" ("approval_status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_requests_requester" ON "financial_requests" ("requester_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_requests_company_date" ON "financial_requests" ("company_id", "request_date")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_salary_advance_deductions_employee_period" ON "financial_salary_advance_deductions" ("employee_id", "period_year", "period_month")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_role_assignments_role" ON "financial_role_assignments" ("role")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_role_assignments_employee" ON "financial_role_assignments" ("employee_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_payments_request" ON "financial_payments" ("request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_refunds_request" ON "financial_refunds" ("request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_request_attachments_request" ON "financial_request_attachments" ("request_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_audit_logs_entity" ON "financial_audit_logs" ("entity_type", "entity_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_audit_logs_request" ON "financial_audit_logs" ("request_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_approval_delegations_delegate" ON "financial_approval_delegations" ("delegate_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_financial_advance_allocations_advance" ON "financial_advance_allocations" ("advance_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_workflows" ADD CONSTRAINT "FK_financial_approval_workflows_company" FOREIGN KEY ("company_id") REFERENCES "financial_companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_workflow_steps" ADD CONSTRAINT "FK_financial_workflow_steps_workflow" FOREIGN KEY ("workflow_id") REFERENCES "financial_approval_workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_workflow_steps" ADD CONSTRAINT "FK_financial_workflow_steps_employee" FOREIGN KEY ("approver_employee_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_steps" ADD CONSTRAINT "FK_financial_approval_steps_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_items" ADD CONSTRAINT "FK_financial_request_items_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_items" ADD CONSTRAINT "FK_financial_request_items_category" FOREIGN KEY ("category_id") REFERENCES "financial_expense_categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "FK_financial_requests_company" FOREIGN KEY ("company_id") REFERENCES "financial_companies"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "FK_financial_requests_requester" FOREIGN KEY ("requester_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "FK_financial_requests_department" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_requests" ADD CONSTRAINT "FK_financial_requests_manager" FOREIGN KEY ("direct_manager_id") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_salary_advance_deductions" ADD CONSTRAINT "FK_financial_salary_advance_deductions_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_salary_advance_deductions" ADD CONSTRAINT "FK_financial_salary_advance_deductions_employee" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_salary_advance_deductions" ADD CONSTRAINT "FK_financial_salary_advance_deductions_payroll" FOREIGN KEY ("payroll_id") REFERENCES "payrolls"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_role_assignments" ADD CONSTRAINT "FK_financial_role_assignments_employee" FOREIGN KEY ("employee_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_role_assignments" ADD CONSTRAINT "FK_financial_role_assignments_company" FOREIGN KEY ("company_id") REFERENCES "financial_companies"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_role_assignments" ADD CONSTRAINT "FK_financial_role_assignments_department" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_payments" ADD CONSTRAINT "FK_financial_payments_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_refunds" ADD CONSTRAINT "FK_financial_refunds_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "FK_financial_request_attachments_request" FOREIGN KEY ("request_id") REFERENCES "financial_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "FK_financial_request_attachments_item" FOREIGN KEY ("item_id") REFERENCES "financial_request_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "FK_financial_request_attachments_payment" FOREIGN KEY ("payment_id") REFERENCES "financial_payments"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_request_attachments" ADD CONSTRAINT "FK_financial_request_attachments_refund" FOREIGN KEY ("refund_id") REFERENCES "financial_refunds"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_delegations" ADD CONSTRAINT "FK_financial_approval_delegations_delegator" FOREIGN KEY ("delegator_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_approval_delegations" ADD CONSTRAINT "FK_financial_approval_delegations_delegate" FOREIGN KEY ("delegate_id") REFERENCES "employee"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_advance_allocations" ADD CONSTRAINT "FK_financial_advance_allocations_settlement" FOREIGN KEY ("settlement_id") REFERENCES "financial_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "financial_advance_allocations" ADD CONSTRAINT "FK_financial_advance_allocations_advance" FOREIGN KEY ("advance_id") REFERENCES "financial_requests"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  private async createExtras(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_financial_approval_workflows_active_scope"
        ON "financial_approval_workflows" (COALESCE("company_id", 0), COALESCE("request_type", '*'))
        WHERE "is_active"
    `);
    await queryRunner.query(`
      CREATE FUNCTION "financial_audit_logs_immutable"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'financial_audit_logs là nhật ký bất biến — không sửa/xoá';
      END;
      $$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_financial_audit_logs_immutable"
        BEFORE UPDATE OR DELETE ON "financial_audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "financial_audit_logs_immutable"()
    `);
    // TRUNCATE không qua trigger dòng — thu luôn quyền ở tầng role ứng dụng.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
          REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "financial_audit_logs" FROM sales_app;
        END IF;
      END
      $$
    `);
  }

  private async seed(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "financial_expense_categories" ("code", "name", "sort_order") VALUES
        ('TRAVEL', 'Chi phí đi lại', 10),
        ('TAXI', 'Taxi/Grab', 20),
        ('AIRFARE', 'Vé máy bay', 30),
        ('LODGING', 'Lưu trú', 40),
        ('MEALS', 'Ăn uống', 50),
        ('FREIGHT', 'Vận chuyển hàng hóa', 60),
        ('SUPPLIES', 'Mua vật tư', 70),
        ('EQUIPMENT', 'Mua thiết bị', 80),
        ('EVENT', 'Tổ chức sự kiện', 90),
        ('OTHER', 'Chi phí khác', 100)
      ON CONFLICT ("code") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "financial_policies" ("scope_key") VALUES ('GLOBAL')
      ON CONFLICT ("scope_key") DO NOTHING
    `);

    // Một câu lệnh duy nhất (không cần đọc id trả về) để có thể trích SQL chạy tay.
    await queryRunner.query(`
      WITH "wf" AS (
        INSERT INTO "financial_approval_workflows" ("name", "description")
        SELECT
          'Quy trình mặc định',
          'Áp dụng cho mọi công ty và loại chứng từ khi chưa có quy trình riêng.'
        WHERE NOT EXISTS (SELECT 1 FROM "financial_approval_workflows")
        RETURNING "id"
      )
      INSERT INTO "financial_workflow_steps"
        ("workflow_id", "step_order", "name", "signature_slot", "approver_type", "approver_role", "can_adjust_amounts", "skippable")
      SELECT "wf"."id", s.* FROM "wf" CROSS JOIN (VALUES
        (1, 'Quản lý trực tiếp', 'MANAGER', 'DIRECT_MANAGER', NULL, false, false),
        (2, 'Bộ phận kiểm soát', 'CONTROLLER', 'ROLE', 'CONTROLLER', true, true),
        (3, 'Kế toán', 'ACCOUNTANT', 'ROLE', 'ACCOUNTANT', true, false),
        (4, 'BGĐ/Trưởng phòng duyệt', 'DIRECTOR', 'ROLE', 'DIRECTOR', false, false)
      ) AS s("step_order", "name", "signature_slot", "approver_type", "approver_role", "can_adjust_amounts", "skippable")
    `);
  }
}
