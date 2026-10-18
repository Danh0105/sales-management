import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Nhật ký bất biến tối thiểu cho từng request Send API. Không lưu nội dung, token,
 * header hay Zalo user id; chỉ fingerprint người nhận và metadata đối soát/quota.
 */
export class AddRecruitmentOutboundAttemptLedger1793200000000 implements MigrationInterface {
  name = 'AddRecruitmentOutboundAttemptLedger1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "recruitment_outbound_attempts" (
      "id" BIGSERIAL NOT NULL,
      "outbox_id" integer NOT NULL,
      "request_no" smallint NOT NULL,
      "lease_owner" character varying(200) NOT NULL,
      "source_type" character varying(24) NOT NULL,
      "channel_account_id" character varying(64) NOT NULL,
      "recipient_fingerprint" character(16) NOT NULL,
      "interaction_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "estimated_cost_vnd" integer NOT NULL DEFAULT 0,
      "outcome" character varying(24) NOT NULL DEFAULT 'DISPATCHING',
      "result_code" character varying(64),
      "provider_message_id" character varying(128),
      "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
      "completed_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "PK_recruitment_outbound_attempts" PRIMARY KEY ("id"),
      CONSTRAINT "FK_outbound_attempt_outbox" FOREIGN KEY ("outbox_id")
        REFERENCES "recruitment_channel_outbox"("id") ON DELETE RESTRICT,
      CONSTRAINT "UQ_outbound_attempt_request" UNIQUE ("outbox_id", "request_no"),
      CONSTRAINT "CHK_outbound_attempt_request_no" CHECK ("request_no" > 0),
      CONSTRAINT "CHK_outbound_attempt_source" CHECK ("source_type" IN ('AI_REPLY', 'HR_MESSAGE')),
      CONSTRAINT "CHK_outbound_attempt_fp" CHECK ("recipient_fingerprint" ~ '^[0-9a-f]{16}$'),
      CONSTRAINT "CHK_outbound_attempt_cost" CHECK ("estimated_cost_vnd" >= 0),
      CONSTRAINT "CHK_outbound_attempt_outcome" CHECK (
        "outcome" IN ('DISPATCHING', 'SENT', 'RETRY', 'UNKNOWN', 'REJECTED', 'DEAD_LETTER')
      ),
      CONSTRAINT "CHK_outbound_attempt_complete" CHECK (
        ("outcome" = 'DISPATCHING') = ("completed_at" IS NULL)
      )
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_attempts_day" ON "recruitment_outbound_attempts" ("started_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbound_attempts_recipient_day" ON "recruitment_outbound_attempts" ("channel_account_id", "recipient_fingerprint", "started_at")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_outbound_attempt_active_lease" ON "recruitment_outbound_attempts" ("outbox_id", "lease_owner") WHERE "outcome" = 'DISPATCHING'`,
    );
    // Ledger là nguồn quota/chi phí: INSERT luôn DISPATCHING + giờ DB; chỉ ghi kết quả
    // một lần; không xoá (xoá = "hoàn" quota + mất bằng chứng đối soát).
    await queryRunner.query(`
      CREATE FUNCTION "recruitment_outbound_attempt_guard"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'request outbound % là bằng chứng đối soát/quota — không xoá được', OLD."id";
        END IF;
        IF TG_OP = 'INSERT' THEN
          NEW."outcome" := 'DISPATCHING';
          NEW."result_code" := NULL;
          NEW."provider_message_id" := NULL;
          NEW."completed_at" := NULL;
          NEW."started_at" := clock_timestamp();
          RETURN NEW;
        END IF;
        IF OLD."outcome" <> 'DISPATCHING' THEN
          RAISE EXCEPTION 'request outbound % đã kết thúc (%) — bất biến', OLD."id", OLD."outcome";
        END IF;
        IF (NEW."id", NEW."outbox_id", NEW."request_no", NEW."lease_owner", NEW."source_type",
            NEW."channel_account_id", NEW."recipient_fingerprint", NEW."interaction_at",
            NEW."estimated_cost_vnd", NEW."started_at")
           IS DISTINCT FROM
           (OLD."id", OLD."outbox_id", OLD."request_no", OLD."lease_owner", OLD."source_type",
            OLD."channel_account_id", OLD."recipient_fingerprint", OLD."interaction_at",
            OLD."estimated_cost_vnd", OLD."started_at") THEN
          RAISE EXCEPTION 'request outbound %: chỉ được ghi kết quả, metadata bất biến', OLD."id";
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_outbound_attempt_guard"
        BEFORE INSERT OR UPDATE OR DELETE ON "recruitment_outbound_attempts"
        FOR EACH ROW EXECUTE FUNCTION "recruitment_outbound_attempt_guard"()
    `);
    await queryRunner.query(
      `COMMENT ON TABLE "recruitment_outbound_attempts" IS 'G8 production: mỗi request Send API Zalo một dòng, ghi trước khi mở mạng. Nguồn quota/chi phí/đối soát. Không nội dung, token hay user id thô. App chỉ thêm + ghi kết quả một lần; không xoá.'`,
    );
    // App: đọc, thêm, ghi kết quả. Không xoá, không sửa metadata.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
          REVOKE ALL ON TABLE "recruitment_outbound_attempts" FROM sales_app;
          GRANT SELECT, INSERT ON TABLE "recruitment_outbound_attempts" TO sales_app;
          GRANT UPDATE ("outcome", "result_code", "provider_message_id", "completed_at")
            ON TABLE "recruitment_outbound_attempts" TO sales_app;
          REVOKE ALL ON SEQUENCE "recruitment_outbound_attempts_id_seq" FROM sales_app;
          GRANT USAGE, SELECT ON SEQUENCE "recruitment_outbound_attempts_id_seq" TO sales_app;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const used = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "recruitment_outbound_attempts"`,
    )) as Array<{ n: number }>;
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new Error(
        'recruitment_outbound_attempts có dữ liệu đối soát — không được xoá',
      );
    }
    await queryRunner.query(`DROP TABLE "recruitment_outbound_attempts"`);
    await queryRunner.query(
      `DROP FUNCTION "recruitment_outbound_attempt_guard"()`,
    );
  }
}
