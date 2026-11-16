import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đề xuất chi Năm cho trường: kinh doanh tích dòng hỗ trợ tiền mặt / thiết bị
 * trong chính sách và nhập số tiền; hoàn thành thì ghi Đã chi của dòng.
 * Chỉ tạo bảng mới, không đổi dữ liệu cũ.
 */
export class AddSuggestPolicySupportItems1796400000000 implements MigrationInterface {
  name = 'AddSuggestPolicySupportItems1796400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "suggest_policy_support_items" (
        "id" SERIAL NOT NULL,
        "suggest_id" integer NOT NULL,
        "policy_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "subject_name" character varying(255),
        "support_type" character varying(20) NOT NULL,
        "item_index" integer NOT NULL,
        "label" character varying(500),
        "policy_amount" numeric(18,2) NOT NULL,
        "amount" numeric(18,2) NOT NULL,
        "spent_amount" numeric(18,2),
        "spent_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_suggest_policy_support_items" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_suggest_policy_support_items_type" CHECK ("support_type" IN ('CASH', 'EQUIPMENT')),
        CONSTRAINT "CHK_suggest_policy_support_items_amount" CHECK ("amount" > 0),
        CONSTRAINT "FK_suggest_policy_support_items_suggest" FOREIGN KEY ("suggest_id")
          REFERENCES "suggest"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_policy_support_items_suggest" ON "suggest_policy_support_items" ("suggest_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_suggest_policy_support_items_policy" ON "suggest_policy_support_items" ("policy_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "suggest_policy_support_items"`);
  }
}
