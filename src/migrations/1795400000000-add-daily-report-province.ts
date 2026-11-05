import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tỉnh/trường là thuộc tính của BÁO CÁO, không phải suy rộng mọi báo cáo từ
 * hồ sơ nhân viên. Nullable có chủ ý: nhân viên đa tỉnh mà không xác định được
 * địa bàn thì giữ NULL và không lọt vào Long An.
 */
export class AddDailyReportProvince1795400000000 implements MigrationInterface {
  name = 'AddDailyReportProvince1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "daily_reports" ADD COLUMN IF NOT EXISTS "province_id" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_reports" ADD COLUMN IF NOT EXISTS "school_id" integer`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_reports_province_id" ON "daily_reports" ("province_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_daily_reports_school_id" ON "daily_reports" ("school_id")`,
    );

    // Backfill theo GPS chỉ khi mọi điểm nhận diện được của cùng báo cáo đều
    // quy về một tỉnh. Dùng trường thuộc tỉnh nhân viên được giao; không đoán
    // Long An chỉ vì người đó còn có Long An trong hồ sơ.
    await queryRunner.query(`
      WITH task_points AS (
        SELECT
          t.id AS task_id,
          t."reportId" AS report_id,
          dr."employeeId" AS employee_id,
          split_part(t.location, ',', 1)::double precision AS latitude,
          split_part(t.location, ',', 2)::double precision AS longitude
        FROM tasks t
        JOIN daily_reports dr ON dr.id = t."reportId"
        WHERE t.location ~ '^\\s*-?[0-9]+(?:\\.[0-9]+)?\\s*,\\s*-?[0-9]+(?:\\.[0-9]+)?\\s*$'
      ), nearest AS (
        SELECT point.report_id, point.task_id, match.province_id
        FROM task_points point
        CROSS JOIN LATERAL (
          SELECT candidate.province_id, candidate.distance_m
          FROM (
            SELECT
              w.province_id,
              s.checkin_radius,
              6371000 * 2 * asin(sqrt(
                power(sin(radians((s.latitude::double precision - point.latitude) / 2)), 2) +
                cos(radians(point.latitude)) * cos(radians(s.latitude::double precision)) *
                power(sin(radians((s.longitude::double precision - point.longitude) / 2)), 2)
              )) AS distance_m
            FROM schools s
            JOIN wards w ON w.id = s.ward_id
            WHERE s.latitude IS NOT NULL
              AND s.longitude IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM employee_region er
                WHERE er.employee_id = point.employee_id
                  AND er.province_id = w.province_id
              )
          ) candidate
          WHERE candidate.distance_m <= GREATEST(COALESCE(candidate.checkin_radius, 200), 1000)
          ORDER BY candidate.distance_m
          LIMIT 1
        ) match
      ), unambiguous AS (
        SELECT report_id, min(province_id) AS province_id
        FROM nearest
        GROUP BY report_id
        HAVING count(DISTINCT province_id) = 1
      )
      UPDATE daily_reports report
      SET province_id = resolved.province_id
      FROM unambiguous resolved
      WHERE report.id = resolved.report_id
        AND report.province_id IS NULL
    `);

    // Fallback chỉ cho nhân viên có đúng một tỉnh (ID 87). Nhân viên kiêm
    // tỉnh giữ NULL nếu GPS/trường không đủ bằng chứng.
    await queryRunner.query(`
      WITH single_province AS (
        SELECT employee_id, min(province_id) AS province_id
        FROM employee_region
        WHERE province_id IS NOT NULL
        GROUP BY employee_id
        HAVING count(DISTINCT province_id) = 1
      )
      UPDATE daily_reports report
      SET province_id = assigned.province_id
      FROM single_province assigned
      WHERE report."employeeId" = assigned.employee_id
        AND report.province_id IS NULL
    `);

    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "daily_reports"
          ADD CONSTRAINT "FK_daily_reports_province"
          FOREIGN KEY ("province_id") REFERENCES "provinces"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "daily_reports"
          ADD CONSTRAINT "FK_daily_reports_school"
          FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "daily_reports" DROP CONSTRAINT IF EXISTS "FK_daily_reports_school"`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_reports" DROP CONSTRAINT IF EXISTS "FK_daily_reports_province"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_daily_reports_school_id"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_daily_reports_province_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_reports" DROP COLUMN IF EXISTS "school_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "daily_reports" DROP COLUMN IF EXISTS "province_id"`,
    );
  }
}
