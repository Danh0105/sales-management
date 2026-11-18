import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TeachingSession } from './entities/teaching-session.entity';
import { SessionStatus } from './teaching.enum';
import { addDays, assertDateOrder } from './teaching.util';
import {
  MISSING_RATE_SQL,
  STAFF_TEACHER_SQL,
} from './teaching-session.service';
import { QueryCollaboratorPayrollDto } from './dto/collaborator-payroll.dto';
import { vnToday } from '../suggest/utils/vn-date';

/** Tối đa một năm học mỗi lần xem. */
export const COLLABORATOR_PAYROLL_MAX_DAYS = 366;

/** Một dòng SQL: một giáo viên CTV dạy một môn ở một trường. */
export type CollaboratorPayrollRawRow = {
  schoolId: number | string;
  schoolName: string | null;
  subjectId: number | string;
  subjectName: string | null;
  subjectCode: string | null;
  schoolYear: string | null;
  teacherId: number | string;
  teacherName: string | null;
  presentSessions: number | string;
  payablePeriods: number | string;
  teachingAmount: number | string;
  otherCostsAmount: number | string;
  minRate: number | string | null;
  maxRate: number | string | null;
  missingRateSessions: number | string;
  uncheckedSessions: number | string;
};

export type CollaboratorPayrollTotals = {
  teacherCount: number;
  presentSessions: number;
  payablePeriods: number;
  teachingAmount: number;
  otherCostsAmount: number;
  totalAmount: number;
  missingRateSessions: number;
  uncheckedSessions: number;
};

export type CollaboratorPayrollTeacher = Omit<
  CollaboratorPayrollTotals,
  'teacherCount'
> & {
  teacherId: number;
  teacherName: string;
  minRate: number | null;
  maxRate: number | null;
};

export type CollaboratorPayrollSubject = CollaboratorPayrollTotals & {
  subjectId: number;
  subjectName: string;
  subjectCode: string | null;
  schoolYear: string | null;
  teachers: CollaboratorPayrollTeacher[];
};

export type CollaboratorPayrollSchool = CollaboratorPayrollTotals & {
  schoolId: number;
  schoolName: string;
  subjects: CollaboratorPayrollSubject[];
};

export type CollaboratorPayrollResult = {
  fromDate: string;
  toDate: string;
  schools: CollaboratorPayrollSchool[];
  grandTotal: CollaboratorPayrollTotals;
};

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toNullableNumber = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? null
    : toNumber(value);

const compareText = (a: string, b: string) =>
  a.localeCompare(b, 'vi', { sensitivity: 'base' });

/** Cộng các dòng con; số giáo viên đếm theo id để GV dạy 2 môn chỉ tính 1. */
function sumTotals(
  rows: Array<Omit<CollaboratorPayrollTotals, 'teacherCount'>>,
  teacherIds: Iterable<number>,
): CollaboratorPayrollTotals {
  const total = rows.reduce(
    (sum, row) => ({
      presentSessions: sum.presentSessions + row.presentSessions,
      payablePeriods: sum.payablePeriods + row.payablePeriods,
      teachingAmount: sum.teachingAmount + row.teachingAmount,
      otherCostsAmount: sum.otherCostsAmount + row.otherCostsAmount,
      totalAmount: sum.totalAmount + row.totalAmount,
      missingRateSessions: sum.missingRateSessions + row.missingRateSessions,
      uncheckedSessions: sum.uncheckedSessions + row.uncheckedSessions,
    }),
    {
      presentSessions: 0,
      payablePeriods: 0,
      teachingAmount: 0,
      otherCostsAmount: 0,
      totalAmount: 0,
      missingRateSessions: 0,
      uncheckedSessions: 0,
    },
  );
  // Không dùng `new Set(teacherIds)`: overload Iterable của Set làm tsc đổi thứ
  // tự rút gọn union và báo lỗi giả ở recruitment/channels/ai-reply-policy.ts.
  const ids = new Set<number>();
  for (const id of teacherIds) ids.add(id);
  return { teacherCount: ids.size, ...total };
}

/**
 * Gom các dòng SQL (trường × môn × giáo viên) thành cây trường → môn → giáo
 * viên kèm tổng từng cấp. Thứ tự: tên trường, mã/tên môn, tên giáo viên.
 */
export function groupCollaboratorPayroll(
  rawRows: CollaboratorPayrollRawRow[],
): { schools: CollaboratorPayrollSchool[]; grandTotal: CollaboratorPayrollTotals } {
  const schools = new Map<
    number,
    {
      schoolName: string;
      subjects: Map<
        number,
        Omit<CollaboratorPayrollSubject, keyof CollaboratorPayrollTotals>
      >;
    }
  >();

  for (const raw of rawRows) {
    const schoolId = toNumber(raw.schoolId);
    const subjectId = toNumber(raw.subjectId);
    const teachingAmount = toNumber(raw.teachingAmount);
    const otherCostsAmount = toNumber(raw.otherCostsAmount);
    const teacher: CollaboratorPayrollTeacher = {
      teacherId: toNumber(raw.teacherId),
      teacherName: raw.teacherName || `Giáo viên #${raw.teacherId}`,
      presentSessions: toNumber(raw.presentSessions),
      payablePeriods: toNumber(raw.payablePeriods),
      minRate: toNullableNumber(raw.minRate),
      maxRate: toNullableNumber(raw.maxRate),
      teachingAmount,
      otherCostsAmount,
      totalAmount: teachingAmount + otherCostsAmount,
      missingRateSessions: toNumber(raw.missingRateSessions),
      uncheckedSessions: toNumber(raw.uncheckedSessions),
    };

    let school = schools.get(schoolId);
    if (!school) {
      school = {
        schoolName: raw.schoolName || `Trường #${schoolId}`,
        subjects: new Map(),
      };
      schools.set(schoolId, school);
    }

    let subject = school.subjects.get(subjectId);
    if (!subject) {
      subject = {
        subjectId,
        subjectName: raw.subjectName || `Môn #${subjectId}`,
        subjectCode: raw.subjectCode || null,
        schoolYear: raw.schoolYear || null,
        teachers: [],
      };
      school.subjects.set(subjectId, subject);
    }
    subject.teachers.push(teacher);
  }

  const schoolList: CollaboratorPayrollSchool[] = [...schools.entries()]
    .map(([schoolId, school]) => {
      const subjects: CollaboratorPayrollSubject[] = [
        ...school.subjects.values(),
      ]
        .map((subject) => {
          const teachers = [...subject.teachers].sort((a, b) =>
            compareText(a.teacherName, b.teacherName),
          );
          return {
            ...subject,
            teachers,
            ...sumTotals(
              teachers,
              teachers.map((t) => t.teacherId),
            ),
          };
        })
        .sort((a, b) =>
          compareText(
            `${a.subjectCode || ''} ${a.subjectName}`,
            `${b.subjectCode || ''} ${b.subjectName}`,
          ),
        );
      return {
        schoolId,
        schoolName: school.schoolName,
        subjects,
        ...sumTotals(
          subjects,
          subjects.flatMap((s) => s.teachers.map((t) => t.teacherId)),
        ),
      };
    })
    .sort((a, b) => compareText(a.schoolName, b.schoolName));

  return {
    schools: schoolList,
    grandTotal: sumTotals(
      schoolList,
      schoolList.flatMap((school) =>
        school.subjects.flatMap((s) => s.teachers.map((t) => t.teacherId)),
      ),
    ),
  };
}

/**
 * Lương giáo viên cộng tác viên theo trường / môn cho màn Quản lý thu chi.
 *
 * Cùng cách tính tiền với bảng tổng hợp chấm công: chỉ buổi PRESENT, tiền dạy
 * = đơn giá tiết × số tiết (thiếu số tiết tính 1), cộng chi phí khác của buổi.
 * Cộng tác viên = mọi giáo viên không có role `giaovien_congty`. Chỉ đọc —
 * không ghi vào bảng thu chi nào.
 */
@Injectable()
export class CollaboratorPayrollService {
  constructor(
    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,
  ) {}

  async summary(
    query: QueryCollaboratorPayrollDto,
    today = vnToday(),
  ): Promise<CollaboratorPayrollResult> {
    assertDateOrder(
      query.fromDate,
      query.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );
    if (
      addDays(query.fromDate, COLLABORATOR_PAYROLL_MAX_DAYS - 1) < query.toDate
    ) {
      throw new BadRequestException(
        `Chỉ xem tối đa ${COLLABORATOR_PAYROLL_MAX_DAYS} ngày mỗi lần`,
      );
    }

    const present = `ss.status = '${SessionStatus.PRESENT}'`;
    // Buổi đã tới ngày mà chưa chấm công: số tiền còn có thể tăng.
    const unchecked = `(ss.status = '${SessionStatus.SCHEDULED}' AND ss.date <= :today)`;

    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .innerJoin('ss.school', 'sc')
      .innerJoin('ss.subject', 'sub')
      .select([
        'ss.schoolId AS "schoolId"',
        'sc.name AS "schoolName"',
        'ss.subjectId AS "subjectId"',
        'sub.name AS "subjectName"',
        'sub.code AS "subjectCode"',
        'sub.schoolYear AS "schoolYear"',
        'ss.teacherId AS "teacherId"',
        't.name AS "teacherName"',
      ])
      .addSelect(`COUNT(*) FILTER (WHERE ${present})`, 'presentSessions')
      .addSelect(
        `COALESCE(SUM(COALESCE(ss.periods, 1)) FILTER (WHERE ${present}), 0)`,
        'payablePeriods',
      )
      .addSelect(
        `COALESCE(SUM(ss.ratePerPeriod * COALESCE(ss.periods, 1)) FILTER (WHERE ${present}), 0)`,
        'teachingAmount',
      )
      .addSelect(
        `COALESCE(SUM(ss.otherCostsTotal) FILTER (WHERE ${present}), 0)`,
        'otherCostsAmount',
      )
      .addSelect(`MIN(ss.ratePerPeriod) FILTER (WHERE ${present})`, 'minRate')
      .addSelect(`MAX(ss.ratePerPeriod) FILTER (WHERE ${present})`, 'maxRate')
      .addSelect(
        `COUNT(*) FILTER (WHERE ${MISSING_RATE_SQL})`,
        'missingRateSessions',
      )
      .addSelect(`COUNT(*) FILTER (WHERE ${unchecked})`, 'uncheckedSessions')
      .where('ss.date >= :fromDate', { fromDate: query.fromDate })
      .andWhere('ss.date <= :toDate', { toDate: query.toDate })
      .andWhere(`NOT ${STAFF_TEACHER_SQL}`)
      .groupBy('ss.schoolId')
      .addGroupBy('sc.name')
      .addGroupBy('ss.subjectId')
      .addGroupBy('sub.name')
      .addGroupBy('sub.code')
      .addGroupBy('sub.schoolYear')
      .addGroupBy('ss.teacherId')
      .addGroupBy('t.name')
      // Bỏ giáo viên chỉ có buổi vắng / huỷ / chưa tới ngày.
      .having(`COUNT(*) FILTER (WHERE ${present} OR ${unchecked}) > 0`)
      .setParameter('today', today);

    if (query.schoolId) {
      qb.andWhere('ss.schoolId = :schoolId', { schoolId: query.schoolId });
    }
    if (query.subjectId) {
      qb.andWhere('ss.subjectId = :subjectId', { subjectId: query.subjectId });
    }

    const rows = await qb.getRawMany<CollaboratorPayrollRawRow>();
    return {
      fromDate: query.fromDate,
      toDate: query.toDate,
      ...groupCollaboratorPayroll(rows),
    };
  }
}
