import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryLessonImagesDto } from './dto/query-lesson-images.dto';
import { LessonImageStorageService } from './lesson-image-storage.service';
import { TeachingScope } from './teaching-roles';

interface LessonImageRow {
  id: number;
  url: string;
  thumbnailUrl: string;
  createdAt: Date | string;
  type: string;
  sessionId: number;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  teacherId: number | null;
  teacherName: string | null;
  schoolId: number;
  schoolName: string;
  schoolLocationId: number | null;
  schoolLocationName: string | null;
  className: string | null;
  subjectName: string;
  provinceId: number | null;
  provinceName: string | null;
}

@Injectable()
export class LessonImageLibraryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: LessonImageStorageService,
  ) {}

  async findAll(query: QueryLessonImagesDto, scope: TeachingScope) {
    if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
      throw new BadRequestException('fromDate phải nhỏ hơn hoặc bằng toDate');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const params: unknown[] = [];
    const where: string[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (scope.kind === 'self') {
      where.push(`t.employee_id = ${bind(scope.employeeId)}`);
    } else if (scope.kind === 'own-schools') {
      const employee = bind(scope.employeeId);
      where.push(`(
        sc.employee_id = ${employee}
        OR EXISTS (
          SELECT 1 FROM employee_region er
          WHERE er.employee_id = ${employee}
            AND (er.ward_id = w.id OR (er.ward_id IS NULL AND er.province_id = w.province_id))
        )
      )`);
    }

    if (query.provinceId) where.push(`w.province_id = ${bind(query.provinceId)}`);
    if (query.schoolId) where.push(`ss.school_id = ${bind(query.schoolId)}`);
    if (query.schoolLocationId) {
      where.push(`ss.school_location_id = ${bind(query.schoolLocationId)}`);
    }
    if (query.teacherId) where.push(`ss.teacher_id = ${bind(query.teacherId)}`);
    if (query.fromDate) where.push(`ss.date >= ${bind(query.fromDate)}::date`);
    if (query.toDate) where.push(`ss.date <= ${bind(query.toDate)}::date`);
    if (query.status) where.push(`ss.status = ${bind(query.status)}`);
    if (query.search) {
      // The current teacher schema has no separate teacher-code column.
      where.push(`(t.name ILIKE ${bind(`%${query.search}%`)} OR t.id::text ILIKE ${bind(`%${query.search}%`)})`);
    }

    const fromSql = `
      FROM lesson_images li
      JOIN teaching_sessions ss ON ss.id = li.session_id
      LEFT JOIN teachers t ON t.id = ss.teacher_id
      JOIN schools sc ON sc.id = ss.school_id
      LEFT JOIN school_locations sl ON sl.id = ss.school_location_id
      LEFT JOIN school_classes cl ON cl.id = ss.class_id
      JOIN subjects su ON su.id = ss.subject_id
      LEFT JOIN wards w ON w.id = sc.ward_id
      LEFT JOIN provinces p ON p.id = w.province_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

    const countParams = [...params];
    const orderColumn = query.sortBy === 'sessionDate' ? 'ss.date' : 'li.created_at';
    const order = query.sortOrder === 'ASC' ? 'ASC' : 'DESC';
    const offsetBind = bind((page - 1) * limit);
    const limitBind = bind(limit);

    const [rows, totals] = await Promise.all([
      this.dataSource.query(
        `SELECT
          li.id, li.url, li.thumbnail_url AS "thumbnailUrl",
          li.created_at AS "createdAt", li.type,
          ss.id AS "sessionId", ss.date, ss.start_time AS "startTime",
          ss.end_time AS "endTime", ss.status,
          t.id AS "teacherId", t.name AS "teacherName",
          sc.id AS "schoolId", sc.name AS "schoolName",
          sl.id AS "schoolLocationId", sl.name AS "schoolLocationName",
          cl.name AS "className", su.name AS "subjectName",
          p.id AS "provinceId", p.name AS "provinceName"
        ${fromSql}
        ORDER BY ${orderColumn} ${order}, li.id ${order}
        OFFSET ${offsetBind} LIMIT ${limitBind}`,
        params,
      ) as Promise<LessonImageRow[]>,
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total,
          COUNT(DISTINCT ss.teacher_id)::int AS "teachersWithImages",
          COUNT(DISTINCT ss.school_id)::int AS "schoolsWithImages"
        ${fromSql}`,
        countParams,
      ) as Promise<Array<{ total: number; teachersWithImages: number; schoolsWithImages: number }>>,
    ]);

    const data = await Promise.all(rows.map(async (row) => ({
      id: Number(row.id),
      thumbnailUrl: await this.storage.ensureThumbnail(row.url, row.thumbnailUrl),
      url: this.storage.publicUrl(row.url),
      createdAt: new Date(row.createdAt).toISOString(),
      type: row.type,
      session: {
        id: Number(row.sessionId), date: row.date,
        startTime: row.startTime?.slice(0, 5), endTime: row.endTime?.slice(0, 5),
        status: row.status,
        teacherId: row.teacherId === null ? null : Number(row.teacherId),
        teacherName: row.teacherName, teacherCode: null,
        schoolId: Number(row.schoolId), schoolName: row.schoolName,
        schoolLocationId: row.schoolLocationId === null ? null : Number(row.schoolLocationId),
        schoolLocationName: row.schoolLocationName,
        className: row.className, subjectName: row.subjectName,
        provinceId: row.provinceId === null ? null : Number(row.provinceId),
        provinceName: row.provinceName,
      },
    })));
    const stats = totals[0] ?? { total: 0, teachersWithImages: 0, schoolsWithImages: 0 };
    const total = Number(stats.total);
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      pagination: { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
      stats: {
        totalImages: total,
        teachersWithImages: Number(stats.teachersWithImages),
        schoolsWithImages: Number(stats.schoolsWithImages),
      },
    };
  }
}
