import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G8 C2S — grant dispatch mới chỉ được tạo từ GO C2S (tách khỏi GO C2 kích hoạt).
 *
 * Schema only: không tạo / sửa grant. Grant đã có (mã `G8-C2-…`) giữ nguyên.
 * Production áp bằng `integrations/openclaw/production/sql/g8-dispatch-guard-c2s-up.sql` (cùng DDL).
 */
export class RequireC2sGoForDispatchGrants1793100000000 implements MigrationInterface {
  name = 'RequireC2sGoForDispatchGrants1793100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "CHK_dispatch_grant_go"`,
    );
    await queryRunner.query(`
      ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "CHK_dispatch_grant_go"
        CHECK ("go_code" ~ '^G8-C2S?-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$')
    `);
    await queryRunner.query(
      `ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "UQ_dispatch_grant_go" UNIQUE ("go_code")`,
    );
    await queryRunner.query(`
      CREATE FUNCTION "recruitment_dispatch_grant_c2s_only"() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW."go_code" !~ '^G8-C2S-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$' THEN
          RAISE EXCEPTION 'grant dispatch mới chỉ được tạo từ GO C2S (G8-C2S-…), không dùng GO C2 kích hoạt';
        END IF;
        RETURN NEW;
      END
      $fn$
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_dispatch_grant_c2s_only"
        BEFORE INSERT ON "recruitment_outbound_dispatch_grants"
        FOR EACH ROW EXECUTE FUNCTION "recruitment_dispatch_grant_c2s_only"()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const c2s = (await queryRunner.query(
      `SELECT count(*)::int AS n FROM "recruitment_outbound_dispatch_grants" WHERE "go_code" ~ '^G8-C2S-'`,
    )) as Array<{ n: number }>;
    if (Number(c2s[0]?.n ?? 0) > 0) {
      throw new Error(
        'đã có grant tạo từ GO C2S — giữ migration (ràng buộc cũ không nhận mã C2S)',
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "TRG_dispatch_grant_c2s_only" ON "recruitment_outbound_dispatch_grants"`,
    );
    await queryRunner.query(
      `DROP FUNCTION "recruitment_dispatch_grant_c2s_only"()`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "UQ_dispatch_grant_go"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recruitment_outbound_dispatch_grants" DROP CONSTRAINT "CHK_dispatch_grant_go"`,
    );
    await queryRunner.query(`
      ALTER TABLE "recruitment_outbound_dispatch_grants" ADD CONSTRAINT "CHK_dispatch_grant_go"
        CHECK ("go_code" ~ '^G8-C2-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$')
    `);
  }
}
