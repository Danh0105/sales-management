import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tách migration riêng để các môi trường đã chạy migration tạo luồng vị trí
 * vẫn nhận được enum thông báo kết quả duyệt/từ chối.
 */
export class AddTeacherLocationResultNotification1788400000000 implements MigrationInterface {
  name = 'AddTeacherLocationResultNotification1788400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "notification_type_enum" ADD VALUE IF NOT EXISTS 'TEACHER_LOCATION_CHANGE_RESULT'`,
    );
  }

  // PostgreSQL không hỗ trợ xoá riêng một enum value an toàn khi có dữ liệu.
  async down(): Promise<void> {}
}
