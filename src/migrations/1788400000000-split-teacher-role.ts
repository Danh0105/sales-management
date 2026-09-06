import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tách role giáo viên `giaovien` thành 2 loại: `giaovien_congty` (công ty) và
 * `giaovien_ctv` (cộng tác viên) — quyền hiện tại giống hệt nhau, tách sẵn để
 * sau này giáo viên công ty được bổ sung quyền riêng.
 *
 * Toàn bộ tài khoản `giaovien` hiện có được chuyển thành `giaovien_congty`
 * (mặc định an toàn nhất — không rút quyền của ai). Nhân sự tự đổi lại thành
 * cộng tác viên cho từng người sau, qua `PATCH /teachers/:id` với `teacherRole`.
 *
 * Runtime chạy synchronize:true nên không có thay đổi schema (`roles` vẫn là
 * `text[]`) — migration này chỉ cập nhật dữ liệu.
 */
export class SplitTeacherRole1788400000000 implements MigrationInterface {
  name = 'SplitTeacherRole1788400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "employee" SET "roles" = array_replace("roles", 'giaovien', 'giaovien_congty') ` +
        `WHERE 'giaovien' = ANY("roles")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Không khôi phục được ai đã bị Nhân sự đổi tay sang giaovien_ctv sau khi
    // chạy up() — chấp nhận vì đây là rollback dữ liệu, không phải cấu trúc.
    await queryRunner.query(
      `UPDATE "employee" SET "roles" = array_replace("roles", 'giaovien_congty', 'giaovien') ` +
        `WHERE 'giaovien_congty' = ANY("roles")`,
    );
  }
}
