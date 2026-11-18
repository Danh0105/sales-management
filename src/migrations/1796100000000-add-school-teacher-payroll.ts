import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Lương giáo viên trường (thay "Lương GV CTV" ở QL thu chi):
 * - `school_teachers`: danh sách giáo viên của trường (tên, STK, ngân hàng, MST);
 * - `school_teacher_expense_items`: bảng "Giáo viên trường" dưới Chi Ngoài, mỗi
 *   dòng gắn một giáo viên; thuế TNCN 10% khi tổng tháng của giáo viên ≥ 5 triệu;
 * - `school_teacher_payroll_approvals`: dấu "Duyệt lương" theo bảng thu chi × môn.
 * Từ kỳ 11/2026 tiền giáo viên trường không còn nằm trong Chi Trường.
 * Ba bảng mới, không đụng dữ liệu cũ. Tên khoá/ràng buộc theo TypeORM sinh từ
 * entity để schema builder không thấy lệch.
 */
export class AddSchoolTeacherPayroll1796100000000 implements MigrationInterface {
  name = 'AddSchoolTeacherPayroll1796100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "school_teachers" (
        "id" SERIAL NOT NULL,
        "school_id" integer NOT NULL,
        "name" character varying(255) NOT NULL,
        "bank_account" character varying(50),
        "bank_name" character varying(100),
        "tax_code" character varying(20),
        "note" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_b619c7f919cbf0ec48612231f07" PRIMARY KEY ("id"),
        CONSTRAINT "FK_48f81529de4f70bb3fff84c2f44" FOREIGN KEY ("school_id")
          REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_school_teachers_school" ON "school_teachers" ("school_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "school_teacher_expense_items" (
        "id" SERIAL NOT NULL,
        "school_expense_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "row_index" integer NOT NULL DEFAULT '0',
        "school_teacher_id" integer,
        "content" text,
        "total_periods" numeric(15,2) NOT NULL DEFAULT '0',
        "student_count" numeric(15,2) NOT NULL DEFAULT '0',
        "months_count" numeric(15,4) NOT NULL DEFAULT '1',
        "unit_price" numeric(15,2) NOT NULL DEFAULT '0',
        "amount" numeric(15,2) NOT NULL DEFAULT '0',
        "pit_rate" numeric(5,2) NOT NULL DEFAULT '0',
        "pit_amount" numeric(15,2) NOT NULL DEFAULT '0',
        "net_amount" numeric(15,2) NOT NULL DEFAULT '0',
        "expense_date" date,
        "cash_account" character varying(20),
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_2d6fd6332d604e4de28194780eb" PRIMARY KEY ("id"),
        CONSTRAINT "FK_83bbb758bf61204dc62007ed2e0" FOREIGN KEY ("school_expense_id")
          REFERENCES "school_expenses"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_273dd6017b86a42264e17af9927" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "FK_12201252dbc6ef17ba7709a5449" FOREIGN KEY ("school_teacher_id")
          REFERENCES "school_teachers"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_school_teacher_expense_items_sheet_subject"
        ON "school_teacher_expense_items" ("school_expense_id", "subject_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "school_teacher_payroll_approvals" (
        "school_expense_id" integer NOT NULL,
        "subject_id" integer NOT NULL,
        "approved_by" integer,
        "approved_by_name" character varying(255),
        "approved_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_01b8990af8b8bbea25eba4895c1" PRIMARY KEY ("school_expense_id", "subject_id"),
        CONSTRAINT "FK_5b6a0fb60118af28f2c34cb33b9" FOREIGN KEY ("school_expense_id")
          REFERENCES "school_expenses"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_3f322796b3bbce5f410952cd130" FOREIGN KEY ("subject_id")
          REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "school_teacher_payroll_approvals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "school_teacher_expense_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "school_teachers"`);
  }
}
