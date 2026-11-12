import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Xác nhận đúng BBCS" bảng Chi Ngoài theo TỪNG MÔN. Trước đây cờ nằm ở
 * `school_expenses` (trường × kỳ) nên xác nhận một môn khoá luôn mọi môn.
 * Bảng đang được xác nhận: chép xác nhận sang mọi môn của trường (user chọn
 * giữ khoá như hiện tại; môn khoá nhầm thì Kế toán trưởng mở khoá riêng).
 * Cột cũ ở `school_expenses` giữ nguyên (code mới đồng bộ = còn môn nào xác nhận).
 */
export class AddManagementConfirmationsPerSubject1796050000000 implements MigrationInterface {
  name = 'AddManagementConfirmationsPerSubject1796050000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "school_expense_management_confirmations" (
        "school_expense_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "confirmed_by" integer,
        "confirmed_by_name" character varying(255),
        "confirmed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_d6472bb0f077156a4ea1d79bb14" PRIMARY KEY ("school_expense_id", "subject_id"),
        CONSTRAINT "FK_80562feee27b0ab7fce8e747cd6" FOREIGN KEY ("school_expense_id")
          REFERENCES "school_expenses"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_3684ad49d11a85a55b05bd23f32" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `INSERT INTO "school_expense_management_confirmations"
         ("school_expense_id", "subject_id", "confirmed_by", "confirmed_by_name", "confirmed_at")
       SELECT se.id, sub.id, se.management_expense_confirmed_by,
         se.management_expense_confirmed_by_name,
         COALESCE(se.management_expense_confirmed_at, now())
       FROM "school_expenses" se
       JOIN "subjects" sub ON sub.school_id = se.school_id
       WHERE se.management_expense_confirmed = true
       ON CONFLICT DO NOTHING`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "school_expense_management_confirmations"`);
  }
}
