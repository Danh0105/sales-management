import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationRisk } from '../database/migration-risk';

/**
 * Mã nhân viên do hệ thống sinh: `NV` + 6 chữ số (NV000001…NV999999).
 *
 * - `hr.employee_code_seq`: sequence PostgreSQL — an toàn khi tạo đồng thời,
 *   số không bao giờ bị dùng lại (có thể có khoảng trống khi một lần tạo bị
 *   rollback — chấp nhận).
 * - Bắt đầu SAU mã `NV######` lớn nhất đang có (hồ sơ tạo tay trước đây), để
 *   không đụng mã cũ. Các mã tạo tay định dạng khác không ảnh hưởng.
 *
 * Rủi ro: SAFE — chỉ tạo sequence mới trong schema hr, không đổi dữ liệu.
 * Rollback: `down()` gỡ sequence (không đụng mã đã sinh trong hr.employees).
 */
export class HrEmployeeCodeSequence1791700000600 implements MigrationInterface {
  name = 'HrEmployeeCodeSequence1791700000600';
  static readonly risk: MigrationRisk = 'SAFE';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE SEQUENCE IF NOT EXISTS "hr"."employee_code_seq"
        AS integer START WITH 1 MINVALUE 1 MAXVALUE 999999 NO CYCLE
    `);
    await queryRunner.query(`
      SELECT setval(
        '"hr"."employee_code_seq"',
        GREATEST(coalesce(max(substring("employee_code" FROM 3)::integer), 0), 1),
        count(*) > 0
      )
      FROM "hr"."employees"
      WHERE "employee_code" ~ '^NV[0-9]{6}$'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "hr"."employee_code_seq"`);
  }
}
