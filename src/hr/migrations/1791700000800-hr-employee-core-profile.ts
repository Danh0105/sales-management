import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Chuẩn hoá họ tên để tìm kiếm không dấu — HỢP ĐỒNG v1, phải GIỐNG HỆT
 * `normalizeVietnameseName()` (src/hr/employees/hr-employee-profile.ts).
 * Test đối chiếu chạy chính biểu thức này trên DB (toàn bộ chữ tiếng Việt,
 * NFC/NFD, khoảng trắng Unicode).
 *
 * Cố ý KHÔNG dùng `unaccent` (chưa cài) và KHÔNG dùng `lower()` (phụ thuộc
 * locale): chỉ A–Z → a–z và Đ/đ → d qua `translate`. Ký tự được dựng bằng
 * `chr()` để không phụ thuộc `standard_conforming_strings`.
 * Yêu cầu database encoding UTF8 (`normalize()`); sai encoding → migration
 * lỗi và rollback toàn bộ.
 *
 * Đóng băng trong migration (không import từ code ứng dụng) để migration cũ
 * không đổi hành vi khi code thay đổi. Công bố qua
 * `HrEmployeeCoreProfile1791700000800.fullNameSearchSql` — KHÔNG export riêng:
 * TypeORM coi mọi export của file migration là một class migration.
 */
const FULL_NAME_SEARCH_SQL = (column: string) => `btrim(
  regexp_replace(
    translate(
      regexp_replace(normalize(${column}, NFD), '[' || chr(768) || '-' || chr(879) || ']', '', 'g'),
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ' || chr(272) || chr(273),
      'abcdefghijklmnopqrstuvwxyzdd'
    ),
    '[' || chr(9) || '-' || chr(13) || chr(32) || chr(160) || chr(5760)
        || chr(8192) || '-' || chr(8202) || chr(8232) || chr(8233) || chr(8239)
        || chr(8287) || chr(12288) || chr(65279) || ']+',
    ' ',
    'g'
  ),
  ' '
)`;

/**
 * Hồ sơ nhân viên cơ bản (Phase 1.2.3) — chỉ THÊM cột vào `hr.employees`.
 *
 * - `attendance_mode`: SHIFT | TEACHING_SESSION | UNASSIGNED, mặc định
 *   UNASSIGNED. Hồ sơ đang có → UNASSIGNED (chưa phân loại), KHÔNG tự thành
 *   SHIFT. Phân loại do import (1.2.4) từ decision file hoặc HR sửa tay.
 * - `date_of_birth`, `gender`, `phone`, `work_email`, `personal_email`: tuỳ
 *   chọn. Dữ liệu cá nhân nhưng không thuộc nhóm định danh phải mã hoá.
 * - `full_name_search`: trường NỘI BỘ, luôn do server tính từ `full_name`
 *   (không nhận từ client/CSV). Backfill ở đây bằng `FULL_NAME_SEARCH_SQL`.
 *   Index B-tree: `LIKE '%x%'` không dùng được index này — chấp nhận ở quy mô
 *   hiện tại; `pg_trgm` + GIN là backlog, migration riêng.
 *
 * KHÔNG thêm dữ liệu việc làm (ngày vào làm, đơn vị, chức danh, quản lý,
 * thử việc, trạng thái việc làm) — thuộc Phase 1.4 Employment History.
 * `status` giữ nguyên ACTIVE/INACTIVE (trạng thái HỒ SƠ hệ thống).
 *
 * Rủi ro: SAFE — ADD COLUMN (nullable hoặc có default), CHECK, backfill cột
 * dẫn xuất, CREATE INDEX. Không sửa dữ liệu nghiệp vụ.
 * Rollback: `down()` gỡ index và bỏ NOT NULL của `full_name_search` để code
 * cũ ghi được; KHÔNG xoá cột (xoá cột = mất dữ liệu, DBA làm tay sau backup).
 */
export class HrEmployeeCoreProfile1791700000800 implements MigrationInterface {
  name = 'HrEmployeeCoreProfile1791700000800';
  static readonly risk: MigrationRisk = 'SAFE';
  static readonly fullNameSearchSql = FULL_NAME_SEARCH_SQL;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hr"."employees"
        ADD COLUMN IF NOT EXISTS "attendance_mode" varchar(20) NOT NULL DEFAULT 'UNASSIGNED',
        ADD COLUMN IF NOT EXISTS "date_of_birth" date,
        ADD COLUMN IF NOT EXISTS "gender" varchar(10),
        ADD COLUMN IF NOT EXISTS "phone" varchar(20),
        ADD COLUMN IF NOT EXISTS "work_email" varchar(254),
        ADD COLUMN IF NOT EXISTS "personal_email" varchar(254),
        ADD COLUMN IF NOT EXISTS "full_name_search" text
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."employees"
        ADD CONSTRAINT "CHK_hr_employees_attendance_mode"
          CHECK ("attendance_mode" IN ('SHIFT','TEACHING_SESSION','UNASSIGNED')),
        ADD CONSTRAINT "CHK_hr_employees_gender"
          CHECK ("gender" IS NULL OR "gender" IN ('MALE','FEMALE','OTHER')),
        ADD CONSTRAINT "CHK_hr_employees_phone"
          CHECK ("phone" IS NULL OR "phone" ~ '^[+]?[0-9]{8,15}$'),
        ADD CONSTRAINT "CHK_hr_employees_work_email"
          CHECK ("work_email" IS NULL OR position('@' IN "work_email") > 1),
        ADD CONSTRAINT "CHK_hr_employees_personal_email"
          CHECK ("personal_email" IS NULL OR position('@' IN "personal_email") > 1),
        ADD CONSTRAINT "CHK_hr_employees_date_of_birth"
          CHECK ("date_of_birth" IS NULL OR "date_of_birth" >= DATE '1900-01-01')
    `);
    // Chỉ ghi cột dẫn xuất mới thêm; không đụng cột nghiệp vụ nào.
    await queryRunner.query(`
      UPDATE "hr"."employees"
         SET "full_name_search" = ${FULL_NAME_SEARCH_SQL('"full_name"')}
       WHERE "full_name_search" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "hr"."employees" ALTER COLUMN "full_name_search" SET NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_hr_employees_full_name_search"
        ON "hr"."employees" ("full_name_search")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_hr_employees_attendance_mode"
        ON "hr"."employees" ("attendance_mode")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "hr"."IX_hr_employees_attendance_mode"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "hr"."IX_hr_employees_full_name_search"`,
    );
    await queryRunner.query(`
      ALTER TABLE "hr"."employees" ALTER COLUMN "full_name_search" DROP NOT NULL
    `);
  }
}
