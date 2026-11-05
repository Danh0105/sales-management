import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

type ReportTaskLocation = {
  location?: string;
  schoolId?: number | null;
};

type ReportLocationInput = {
  provinceId?: number | null;
  schoolId?: number | null;
  tasks?: ReportTaskLocation[];
};

export type ResolvedReportLocation = {
  provinceId: number | null;
  schoolId: number | null;
};

const COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/**
 * Chốt tỉnh của báo cáo từ dữ liệu nghiệp vụ, không từ việc nhân viên "có
 * Long An trong danh sách tỉnh". Nhân viên đa tỉnh chỉ được gắn tỉnh khi có
 * trường/GPS hoặc lựa chọn tỉnh hợp lệ; không đủ bằng chứng thì để NULL.
 */
@Injectable()
export class DailyReportProvinceService {
  constructor(private readonly dataSource: DataSource) {}

  async resolve(
    employeeId: number,
    input: ReportLocationInput,
  ): Promise<ResolvedReportLocation> {
    const schoolIds = [
      input.schoolId,
      ...(input.tasks ?? []).map((task) => task.schoolId),
    ].filter((id): id is number => Number.isInteger(id) && Number(id) > 0);

    if (schoolIds.length) {
      const uniqueIds = [...new Set(schoolIds.map(Number))];
      const schools: { id: number; province_id: number }[] =
        await this.dataSource.query(
          `SELECT s.id, w.province_id
           FROM schools s
           JOIN wards w ON w.id = s.ward_id
           WHERE s.id = ANY($1::int[])
             AND s.employee_id = $2`,
          [uniqueIds, employeeId],
        );
      if (schools.length !== uniqueIds.length) {
        throw new BadRequestException(
          'Trường báo cáo không thuộc phạm vi nhân viên phụ trách',
        );
      }
      const provinces = [
        ...new Set(schools.map((row) => Number(row.province_id))),
      ];
      return provinces.length === 1
        ? {
            provinceId: provinces[0],
            schoolId: uniqueIds.length === 1 ? uniqueIds[0] : null,
          }
        : { provinceId: null, schoolId: null };
    }

    const gpsProvinces = new Set<number>();
    for (const task of input.tasks ?? []) {
      const point = this.parseCoordinates(task.location);
      if (!point) continue;
      const provinceId = await this.provinceAtEmployeeLocation(
        employeeId,
        point,
      );
      if (provinceId) gpsProvinces.add(provinceId);
    }
    if (gpsProvinces.size === 1) {
      return { provinceId: [...gpsProvinces][0], schoolId: null };
    }
    if (gpsProvinces.size > 1) {
      // Một báo cáo chứa công việc ở nhiều tỉnh không được tự nhận là Long An.
      return { provinceId: null, schoolId: null };
    }

    if (Number.isInteger(input.provinceId) && Number(input.provinceId) > 0) {
      const assigned = await this.dataSource.query<{ allowed: number }[]>(
        `SELECT 1 AS allowed
         FROM employee_region
         WHERE employee_id = $1 AND province_id = $2
         LIMIT 1`,
        [employeeId, Number(input.provinceId)],
      );
      if (!assigned.length) {
        throw new BadRequestException(
          'Tỉnh báo cáo không thuộc phạm vi nhân viên phụ trách',
        );
      }
      return { provinceId: Number(input.provinceId), schoolId: null };
    }

    // Chỉ dùng hồ sơ nhân viên làm fallback khi họ thực sự có đúng một tỉnh.
    // Đây là trường hợp ID 87; nhân viên kiêm tỉnh không đi qua nhánh này.
    const assigned: { province_id: number }[] = await this.dataSource.query(
      `SELECT DISTINCT province_id
       FROM employee_region
       WHERE employee_id = $1 AND province_id IS NOT NULL`,
      [employeeId],
    );
    return assigned.length === 1
      ? { provinceId: Number(assigned[0].province_id), schoolId: null }
      : { provinceId: null, schoolId: null };
  }

  private parseCoordinates(
    location?: string,
  ): { latitude: number; longitude: number } | null {
    const match = location?.match(COORDINATES);
    if (!match) return null;
    const latitude = Number(match[1]);
    const longitude = Number(match[2]);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      return null;
    }
    return { latitude, longitude };
  }

  private async provinceAtEmployeeLocation(
    employeeId: number,
    point: { latitude: number; longitude: number },
  ): Promise<number | null> {
    const rows: { province_id: number; distance_m: number }[] =
      await this.dataSource.query(
        `SELECT candidate.province_id, candidate.distance_m
         FROM (
           SELECT
             w.province_id,
             s.checkin_radius,
             6371000 * 2 * asin(sqrt(
               power(sin(radians((s.latitude::double precision - $2) / 2)), 2) +
               cos(radians($2)) * cos(radians(s.latitude::double precision)) *
               power(sin(radians((s.longitude::double precision - $3) / 2)), 2)
             )) AS distance_m
           FROM schools s
           JOIN wards w ON w.id = s.ward_id
           WHERE s.latitude IS NOT NULL
             AND s.longitude IS NOT NULL
             AND (
               s.employee_id = $1
               OR EXISTS (
                 SELECT 1 FROM employee_region er
                 WHERE er.employee_id = $1 AND er.province_id = w.province_id
               )
             )
         ) candidate
         WHERE candidate.distance_m <= GREATEST(COALESCE(candidate.checkin_radius, 200), 1000)
         ORDER BY candidate.distance_m ASC
         LIMIT 1`,
        [employeeId, point.latitude, point.longitude],
      );
    return rows.length ? Number(rows[0].province_id) : null;
  }
}
