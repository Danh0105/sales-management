import { BadRequestException } from '@nestjs/common';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CollaboratorPayrollController } from './collaborator-payroll.controller';
import {
  CollaboratorPayrollRawRow,
  CollaboratorPayrollService,
  groupCollaboratorPayroll,
} from './collaborator-payroll.service';
import { STAFF_TEACHER_SQL } from './teaching-session.service';

const raw = (
  overrides: Partial<CollaboratorPayrollRawRow>,
): CollaboratorPayrollRawRow => ({
  schoolId: '1',
  schoolName: 'TH Lê Lợi',
  subjectId: '10',
  subjectName: 'STEM',
  subjectCode: 'STEM',
  schoolYear: '2026-2027',
  teacherId: '100',
  teacherName: 'Nguyễn Văn A',
  presentSessions: '0',
  payablePeriods: '0',
  teachingAmount: '0',
  otherCostsAmount: '0',
  minRate: null,
  maxRate: null,
  missingRateSessions: '0',
  uncheckedSessions: '0',
  ...overrides,
});

describe('groupCollaboratorPayroll', () => {
  it('gom trường → môn → giáo viên và cộng tổng từng cấp', () => {
    const result = groupCollaboratorPayroll([
      raw({
        teacherId: '100',
        teacherName: 'Nguyễn Văn A',
        presentSessions: '10',
        payablePeriods: '20',
        teachingAmount: '2000000.00',
        otherCostsAmount: '50000.00',
        minRate: '100000.00',
        maxRate: '100000.00',
      }),
      raw({
        subjectId: '11',
        subjectName: 'Kỹ năng sống',
        subjectCode: 'KNS',
        teacherId: '100',
        teacherName: 'Nguyễn Văn A',
        presentSessions: '2',
        payablePeriods: '4',
        teachingAmount: '320000',
        minRate: '80000',
        maxRate: '80000',
      }),
      raw({
        teacherId: '101',
        teacherName: 'Trần Thị B',
        presentSessions: '6',
        payablePeriods: '12',
        teachingAmount: '1200000',
        missingRateSessions: '1',
        uncheckedSessions: '2',
        minRate: '100000',
        maxRate: '120000',
      }),
      raw({
        schoolId: '2',
        schoolName: 'An Phú',
        subjectId: '20',
        teacherId: '101',
        teacherName: 'Trần Thị B',
        presentSessions: '1',
        payablePeriods: '2',
        teachingAmount: '200000',
      }),
    ]);

    // Trường xếp theo tên.
    expect(result.schools.map((s) => s.schoolName)).toEqual([
      'An Phú',
      'TH Lê Lợi',
    ]);

    const leLoi = result.schools[1];
    // Môn xếp theo mã: KNS trước STEM.
    expect(leLoi.subjects.map((s) => s.subjectCode)).toEqual(['KNS', 'STEM']);

    const stem = leLoi.subjects[1];
    expect(stem.teachers.map((t) => t.teacherName)).toEqual([
      'Nguyễn Văn A',
      'Trần Thị B',
    ]);
    expect(stem.teachers[0]).toMatchObject({
      teacherId: 100,
      presentSessions: 10,
      payablePeriods: 20,
      teachingAmount: 2_000_000,
      otherCostsAmount: 50_000,
      totalAmount: 2_050_000,
      minRate: 100_000,
      maxRate: 100_000,
    });
    expect(stem).toMatchObject({
      teacherCount: 2,
      presentSessions: 16,
      payablePeriods: 32,
      teachingAmount: 3_200_000,
      otherCostsAmount: 50_000,
      totalAmount: 3_250_000,
      missingRateSessions: 1,
      uncheckedSessions: 2,
    });

    // GV A dạy 2 môn ở Lê Lợi → trường chỉ đếm 2 giáo viên.
    expect(leLoi).toMatchObject({
      teacherCount: 2,
      payablePeriods: 36,
      teachingAmount: 3_520_000,
      totalAmount: 3_570_000,
    });

    // GV B dạy ở cả 2 trường → tổng chung chỉ đếm 2 giáo viên.
    expect(result.grandTotal).toEqual({
      teacherCount: 2,
      presentSessions: 19,
      payablePeriods: 38,
      teachingAmount: 3_720_000,
      otherCostsAmount: 50_000,
      totalAmount: 3_770_000,
      missingRateSessions: 1,
      uncheckedSessions: 2,
    });
  });

  it('không có dữ liệu → danh sách rỗng, tổng 0', () => {
    expect(groupCollaboratorPayroll([])).toEqual({
      schools: [],
      grandTotal: {
        teacherCount: 0,
        presentSessions: 0,
        payablePeriods: 0,
        teachingAmount: 0,
        otherCostsAmount: 0,
        totalAmount: 0,
        missingRateSessions: 0,
        uncheckedSessions: 0,
      },
    });
  });

  it('đơn giá trống giữ null, không đổi thành 0', () => {
    const [school] = groupCollaboratorPayroll([
      raw({ uncheckedSessions: '3' }),
    ]).schools;
    expect(school.subjects[0].teachers[0]).toMatchObject({
      minRate: null,
      maxRate: null,
      totalAmount: 0,
      uncheckedSessions: 3,
    });
  });
});

describe('CollaboratorPayrollService.summary', () => {
  const makeQb = (rows: CollaboratorPayrollRawRow[] = []) => {
    const calls: { method: string; args: unknown[] }[] = [];
    const qb: any = new Proxy(
      {},
      {
        get(_target, method: string) {
          if (method === 'getRawMany') return async () => rows;
          if (method === 'then') return undefined;
          return (...args: unknown[]) => {
            calls.push({ method, args });
            return qb;
          };
        },
      },
    );
    return { qb, calls };
  };

  const makeService = (rows: CollaboratorPayrollRawRow[] = []) => {
    const { qb, calls } = makeQb(rows);
    const repo = { createQueryBuilder: jest.fn(() => qb) };
    return {
      service: new CollaboratorPayrollService(repo as any),
      calls,
      repo,
    };
  };

  it('chỉ lấy giáo viên không phải công ty, lọc trường + môn khi có', async () => {
    const { service, calls } = makeService([
      raw({ presentSessions: '1', payablePeriods: '2', teachingAmount: '1' }),
    ]);

    const result = await service.summary(
      {
        fromDate: '2026-11-01',
        toDate: '2026-11-30',
        schoolId: 1,
        subjectId: 10,
      },
      '2026-11-10',
    );

    const where = calls
      .filter((c) => ['where', 'andWhere'].includes(c.method))
      .map((c) => c.args);
    expect(where).toEqual(
      expect.arrayContaining([
        ['ss.date >= :fromDate', { fromDate: '2026-11-01' }],
        ['ss.date <= :toDate', { toDate: '2026-11-30' }],
        [`NOT ${STAFF_TEACHER_SQL}`],
        ['ss.schoolId = :schoolId', { schoolId: 1 }],
        ['ss.subjectId = :subjectId', { subjectId: 10 }],
      ]),
    );
    expect(calls).toContainEqual({
      method: 'setParameter',
      args: ['today', '2026-11-10'],
    });

    // Tiền chỉ tính buổi PRESENT.
    const selects = calls
      .filter((c) => c.method === 'addSelect')
      .map((c) => c.args);
    expect(selects).toContainEqual([
      "COALESCE(SUM(ss.ratePerPeriod * COALESCE(ss.periods, 1)) FILTER (WHERE ss.status = 'PRESENT'), 0)",
      'teachingAmount',
    ]);

    expect(result).toMatchObject({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      grandTotal: { payablePeriods: 2, teacherCount: 1 },
    });
  });

  it('không lọc trường / môn khi không truyền', async () => {
    const { service, calls } = makeService();
    await service.summary({ fromDate: '2026-11-01', toDate: '2026-11-30' });
    const filters = calls
      .filter((c) => c.method === 'andWhere')
      .map((c) => String(c.args[0]));
    expect(filters.some((f) => f.includes('schoolId'))).toBe(false);
    expect(filters.some((f) => f.includes('subjectId'))).toBe(false);
  });

  it('fromDate sau toDate → 400', async () => {
    const { service, repo } = makeService();
    await expect(
      service.summary({ fromDate: '2026-11-30', toDate: '2026-11-01' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('quá 366 ngày → 400, đúng 366 ngày thì được', async () => {
    const { service } = makeService();
    await expect(
      service.summary({ fromDate: '2026-08-01', toDate: '2027-08-02' }),
    ).rejects.toThrow('Chỉ xem tối đa 366 ngày mỗi lần');
    await expect(
      service.summary({ fromDate: '2026-08-01', toDate: '2027-08-01' }),
    ).resolves.toMatchObject({ schools: [] });
  });
});

describe('CollaboratorPayrollController quyền', () => {
  const roles: string[] = Reflect.getMetadata(
    ROLES_KEY,
    CollaboratorPayrollController.prototype.summary,
  );

  it('mọi vai trò ghi Quản lý thu chi được xem', () => {
    expect([...roles].sort()).toEqual(
      [
        'accountant',
        'director',
        'ketoan_congno',
        'ketoan_truong',
        'thuquy',
        'troly_gd',
      ].sort(),
    );
  });

  it('sales admin, kinh doanh, giáo viên, Giám đốc Long An không xem được', () => {
    for (const role of [
      'saleadmin',
      'salesadmin',
      'salesadmin_la',
      'sales',
      'giaovien_ctv',
      'giaovien_congty',
      'director_la',
    ]) {
      expect(roles).not.toContain(role);
    }
  });
});
