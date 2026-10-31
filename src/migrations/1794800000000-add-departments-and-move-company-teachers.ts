import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PHÒNG BAN cho phân quyền tài chính theo phạm vi (Cấu hình quy trình ›
 * Phân quyền › Phòng ban): thêm 7 phòng vào bảng `department` (đang chỉ có
 * Kinh doanh, Nhân sự) và chuyển mọi giáo viên công ty (`giaovien_congty`)
 * sang phòng Chuyên môn. Cộng tác viên (`giaovien_ctv`) giữ nguyên phòng.
 *
 * Tên phòng theo cách đặt sẵn có (không tiền tố "Phòng"). Tên "Chuyên môn"
 * phải khớp `TEACHER_STAFF_DEPARTMENT` — tài khoản giáo viên công ty mới tra
 * phòng theo tên này.
 *
 * Chạy lại an toàn: phòng đã có (trùng tên) thì bỏ qua; giáo viên đã ở phòng
 * Chuyên môn thì không ghi lại.
 *
 * down() chỉ trả giáo viên về phòng #1 (Kinh doanh — mặc định của tài khoản
 * giáo viên trước đây) và xoá các phòng chưa có ai/khu vực/tin tuyển dụng/
 * phiếu/phân quyền nào tham chiếu (phân quyền bị xoá dây chuyền theo FK nên
 * phải giữ phòng). Phòng cũ của từng người không lưu ở đây: cần chính xác thì khôi
 * phục từ bản sao lưu lúc chạy.
 */
export class AddDepartmentsAndMoveCompanyTeachers1794800000000
  implements MigrationInterface
{
  name = 'AddDepartmentsAndMoveCompanyTeachers1794800000000';

  private static readonly DEPARTMENTS: [name: string, icon: string][] = [
    ['Chuyên môn', '🎓'],
    ['Sản xuất', '🏭'],
    ['Kế toán', '🧮'],
    ['Kỹ thuật', '🔧'],
    ['Công nghệ', '💻'],
    ['Giáo vụ', '📚'],
    ['Sales Admin', '🗂️'],
  ];

  private static readonly STAFF_DEPARTMENT = 'Chuyên môn';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const { DEPARTMENTS, STAFF_DEPARTMENT } =
      AddDepartmentsAndMoveCompanyTeachers1794800000000;
    await queryRunner.query(
      `INSERT INTO "department" ("name", "icon")
       SELECT * FROM unnest($1::varchar[], $2::varchar[])
       ON CONFLICT ("name") DO NOTHING`,
      [DEPARTMENTS.map(([name]) => name), DEPARTMENTS.map(([, icon]) => icon)],
    );
    await queryRunner.query(
      `UPDATE "employee" e SET "department_id" = d."id"
       FROM "department" d
       WHERE d."name" = $1
         AND 'giaovien_congty' = ANY(e."roles")
         AND e."department_id" IS DISTINCT FROM d."id"`,
      [STAFF_DEPARTMENT],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const { DEPARTMENTS, STAFF_DEPARTMENT } =
      AddDepartmentsAndMoveCompanyTeachers1794800000000;
    await queryRunner.query(
      `UPDATE "employee" e SET "department_id" = 1
       FROM "department" d
       WHERE d."name" = $1
         AND e."department_id" = d."id"
         AND 'giaovien_congty' = ANY(e."roles")`,
      [STAFF_DEPARTMENT],
    );
    await queryRunner.query(
      `DELETE FROM "department" d
       WHERE d."name" = ANY($1::varchar[])
         AND NOT EXISTS (SELECT 1 FROM "employee" WHERE "department_id" = d."id")
         AND NOT EXISTS (SELECT 1 FROM "region" WHERE "department_id" = d."id")
         AND NOT EXISTS (SELECT 1 FROM "recruitment_jobs" WHERE "department_id" = d."id")
         AND NOT EXISTS (SELECT 1 FROM "financial_requests" WHERE "department_id" = d."id")
         AND NOT EXISTS (SELECT 1 FROM "financial_role_assignments" WHERE "department_id" = d."id")`,
      [DEPARTMENTS.map(([name]) => name)],
    );
  }
}
