import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Đơn giá mỗi tiết cho giáo viên:
 * - teachers.default_rate_per_period: đơn giá mặc định của giáo viên.
 * - teaching_schedules.rate_per_period: đơn giá riêng cho một mẫu lịch.
 * - teaching_sessions.rate_per_period: đơn giá **chốt tại thời điểm tạo buổi**.
 *
 * Chốt vào từng buổi thay vì tra ngược lúc tính lương: đơn giá thay đổi theo
 * thời gian, nếu tra ngược thì sửa đơn giá hôm nay sẽ làm lệch cả bảng công đã
 * chốt của các tháng trước.
 *
 * Tất cả đều nullable — dữ liệu cũ chưa khai giá vẫn chạy, chỉ là chưa tính
 * được tiền cho tới khi Nhân sự khai đơn giá.
 *
 * Runtime chạy synchronize:true nên cột được tạo tự động khi khởi động lại;
 * migration dành cho môi trường tắt synchronize.
 */
export class AddTeachingRatePerPeriod1786500000000 implements MigrationInterface {
    name = 'AddTeachingRatePerPeriod1786500000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "default_rate_per_period" numeric(15,2)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" ADD COLUMN IF NOT EXISTS "rate_per_period" numeric(15,2)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" ADD COLUMN IF NOT EXISTS "rate_per_period" numeric(15,2)`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teaching_sessions" DROP COLUMN IF EXISTS "rate_per_period"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "rate_per_period"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "default_rate_per_period"`,
        );
    }
}
