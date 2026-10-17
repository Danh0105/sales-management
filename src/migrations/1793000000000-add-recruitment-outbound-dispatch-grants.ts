import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G8 C2 — single dispatch guard: grant dispatch của SYSTEM OWNER.
 *
 * Schema only: does NOT enable outbound and does NOT create any grant.
 * Production áp bằng `integrations/openclaw/production/sql/g8-dispatch-guard-up.sql`
 * (cùng DDL, chạy với role `sales_owner`, tự kiểm quyền `sales_app`).
 */
export class AddRecruitmentOutboundDispatchGrants1793000000000 implements MigrationInterface {
  name = 'AddRecruitmentOutboundDispatchGrants1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recruitment_outbound_dispatch_grants" (
        "id" serial NOT NULL,
        "go_code" varchar(64) NOT NULL,
        "outbox_id" integer NOT NULL,
        "channel_account_id" varchar(64) NOT NULL,
        "recipient_fingerprint" char(16) NOT NULL,
        "approved_text_sha256" char(64) NOT NULL,
        "approved_control_version" integer NOT NULL,
        "max_dispatches" smallint NOT NULL DEFAULT 1,
        "dispatches_used" smallint NOT NULL DEFAULT 0,
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "created_by" varchar(120) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "consumed_lease_owner" varchar(200),
        "revoked_at" timestamptz,
        "revoked_by" varchar(120),
        "reason" varchar(500),
        CONSTRAINT "PK_dispatch_grants" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_dispatch_grant_outbox" UNIQUE ("outbox_id"),
        CONSTRAINT "FK_dispatch_grant_outbox" FOREIGN KEY ("outbox_id")
          REFERENCES "recruitment_channel_outbox"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_dispatch_grant_max" CHECK ("max_dispatches" = 1),
        CONSTRAINT "CHK_dispatch_grant_used" CHECK ("dispatches_used" BETWEEN 0 AND "max_dispatches"),
        CONSTRAINT "CHK_dispatch_grant_status" CHECK ("status" IN ('ACTIVE', 'CONSUMED', 'REVOKED')),
        CONSTRAINT "CHK_dispatch_grant_consumed" CHECK (("status" = 'CONSUMED') = ("dispatches_used" = "max_dispatches")),
        CONSTRAINT "CHK_dispatch_grant_consumed_at" CHECK (("dispatches_used" = 0) = ("consumed_at" IS NULL)),
        CONSTRAINT "CHK_dispatch_grant_revoked" CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL)),
        CONSTRAINT "CHK_dispatch_grant_fp" CHECK ("recipient_fingerprint" ~ '^[0-9a-f]{16}$'),
        CONSTRAINT "CHK_dispatch_grant_sha" CHECK ("approved_text_sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "CHK_dispatch_grant_go" CHECK ("go_code" ~ '^G8-C2-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$'),
        CONSTRAINT "CHK_dispatch_grant_window" CHECK (
          "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '2 hours')
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_dispatch_grant_one_active"
        ON "recruitment_outbound_dispatch_grants" ((true)) WHERE "status" = 'ACTIVE'
    `);
    // Một chiều: chỉ grant ACTIVE đổi được, không "hoàn" hạn mức, phạm vi bất biến, không xoá grant đã tiêu.
    await queryRunner.query(`
CREATE FUNCTION "recruitment_dispatch_grant_guard"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."dispatches_used" > 0 THEN
      RAISE EXCEPTION 'grant % đã được tiêu — không xoá được (bằng chứng audit)', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'grant % đang % — không đổi được', OLD."id", OLD."status";
  END IF;
  IF NEW."dispatches_used" < OLD."dispatches_used" THEN
    RAISE EXCEPTION 'grant %: không được giảm dispatches_used', OLD."id";
  END IF;
  IF (NEW."go_code", NEW."outbox_id", NEW."channel_account_id", NEW."recipient_fingerprint",
      NEW."approved_text_sha256", NEW."approved_control_version", NEW."max_dispatches",
      NEW."created_by", NEW."created_at", NEW."expires_at")
     IS DISTINCT FROM
     (OLD."go_code", OLD."outbox_id", OLD."channel_account_id", OLD."recipient_fingerprint",
      OLD."approved_text_sha256", OLD."approved_control_version", OLD."max_dispatches",
      OLD."created_by", OLD."created_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'grant %: phạm vi grant là bất biến', OLD."id";
  END IF;
  RETURN NEW;
END
$fn$;
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_dispatch_grant_guard"
  BEFORE UPDATE OR DELETE ON "recruitment_outbound_dispatch_grants"
  FOR EACH ROW EXECUTE FUNCTION "recruitment_dispatch_grant_guard"()
    `);
    // App chỉ đọc + tiêu grant; tạo/thu hồi là việc của Owner (postgres).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sales_app') THEN
          REVOKE ALL ON TABLE "recruitment_outbound_dispatch_grants" FROM sales_app;
          GRANT SELECT ON TABLE "recruitment_outbound_dispatch_grants" TO sales_app;
          GRANT UPDATE ("dispatches_used", "status", "consumed_at", "consumed_lease_owner")
            ON TABLE "recruitment_outbound_dispatch_grants" TO sales_app;
          REVOKE ALL ON SEQUENCE "recruitment_outbound_dispatch_grants_id_seq" FROM sales_app;
        END IF;
      END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const used = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "recruitment_outbound_dispatch_grants" WHERE "dispatches_used" > 0`,
    )) as Array<{ n: number }>;
    if (Number(used[0]?.n ?? 0) > 0) {
      throw new Error(
        'recruitment_outbound_dispatch_grants có grant đã tiêu — giữ bảng làm bằng chứng',
      );
    }
    await queryRunner.query(
      `DROP TABLE "recruitment_outbound_dispatch_grants"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "recruitment_dispatch_grant_guard"()`,
    );
  }
}
