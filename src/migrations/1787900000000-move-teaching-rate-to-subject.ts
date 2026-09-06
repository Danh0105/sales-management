import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chuyển đơn giá dạy học từ "theo giáo viên/mẫu lịch" sang "theo môn học":
 * - subjects.rate_per_period: đơn giá mỗi tiết Nhân sự khai theo môn học của
 *   từng trường (mới).
 * - teachers.default_rate_per_period, teaching_schedules.rate_per_period: bỏ —
 *   không còn khai giá ở hai cấp này nữa.
 * - teaching_sessions.rate_per_period: GIỮ NGUYÊN — vẫn là giá "chốt tại thời
 *   điểm tạo buổi", giờ chốt từ subject.ratePerPeriod thay vì từ mẫu lịch/giáo
 *   viên. Dữ liệu lịch sử của các buổi đã tạo không bị đụng tới.
 *
 * Runtime chạy synchronize:true nên cột được tạo/xoá tự động khi khởi động
 * lại; migration dành cho môi trường tắt synchronize.
 */
export class MoveTeachingRateToSubject1787900000000 implements MigrationInterface {
    name = 'MoveTeachingRateToSubject1787900000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "rate_per_period" numeric(15,2)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" DROP COLUMN IF EXISTS "rate_per_period"`,
        );
        await queryRunner.query(
            `ALTER TABLE "teachers" DROP COLUMN IF EXISTS "default_rate_per_period"`,
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `ALTER TABLE "teachers" ADD COLUMN IF NOT EXISTS "default_rate_per_period" numeric(15,2)`,
        );
        await queryRunner.query(
            `ALTER TABLE "teaching_schedules" ADD COLUMN IF NOT EXISTS "rate_per_period" numeric(15,2)`,
        );
        await queryRunner.query(
            `ALTER TABLE "subjects" DROP COLUMN IF EXISTS "rate_per_period"`,
        );
    }
}
