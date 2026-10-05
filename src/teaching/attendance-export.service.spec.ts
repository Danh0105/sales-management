import {
  BadRequestException,
  CanActivate,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { LessonImageLibraryService } from './lesson-image-library.service';
import { TeachingBulkService } from './teaching-bulk.service';
import { TeachingSessionController } from './teaching-session.controller';
import * as ExcelJS from 'exceljs';
import {
  AttendanceExportService,
  AttendanceSummaryRow,
  attendanceExportFileName,
  buildAttendanceWorkbook,
  compareVietnameseNames,
  UNKNOWN_PROVINCE,
} from './attendance-export.service';
import {
  applyTeacherRoleFilter,
  STAFF_TEACHER_SQL,
  TeachingSessionService,
} from './teaching-session.service';
import {
  TEACHER_COLLABORATOR_ROLE,
  TEACHER_STAFF_ROLE,
} from './teaching-roles';

function summaryRow(
  teacherId: number,
  teacherName: string,
  overrides: Partial<AttendanceSummaryRow> = {},
): AttendanceSummaryRow {
  return {
    teacherId,
    teacherName,
    totalSessions: 0,
    present: 0,
    absent: 0,
    excused: 0,
    cancelled: 0,
    unchecked: 0,
    makeup: 0,
    totalPeriods: 0,
    payablePeriods: 0,
    payableAmount: 0,
    otherCostsAmount: 0,
    fuelAllowanceAmount: 0,
    totalDistanceKm: 0,
    totalPayableAmount: 0,
    missingRateSessions: 0,
    ...overrides,
  };
}

/** Giá trị hiển thị của ô: công thức thì lấy `result` đã tính sẵn. */
function shown(cell: ExcelJS.Cell): unknown {
  const value = cell.value as any;
  return value && typeof value === 'object' && 'formula' in value
    ? value.result
    : value;
}

function findRow(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (ws.getCell(r, 1).value === label) return r;
  }
  throw new Error(`Không thấy dòng "${label}"`);
}

const INPUT = {
  fromDate: '2026-09-01',
  toDate: '2026-09-30',
  rows: [
    summaryRow(1, 'Trần Văn Bình', {
      totalSessions: 5,
      present: 4,
      unchecked: 1,
      totalPeriods: 5,
      payablePeriods: 4,
      payableAmount: 400000,
      otherCostsAmount: 50000,
    }),
    summaryRow(2, 'Lê Thị An', {
      totalSessions: 3,
      present: 3,
      totalPeriods: 3,
      payablePeriods: 3,
      fuelAllowanceAmount: 60000,
      totalDistanceKm: 12.5,
    }),
    summaryRow(3, 'Phạm Cường', { totalSessions: 2, present: 2 }),
    summaryRow(4, 'Ngô Dũng', { totalSessions: 1, unchecked: 1 }),
  ],
  daily: [
    // Bình: 3 tiết HCM + 1 tiết Tây Ninh → nhóm HCM, vẫn đủ 4 tiết trên dòng.
    {
      teacherId: 1,
      date: '2026-09-01',
      provinceName: 'Hồ Chí Minh',
      periods: 2,
      sessions: 2,
    },
    {
      teacherId: 1,
      date: '2026-09-02',
      provinceName: 'Hồ Chí Minh',
      periods: 1,
      sessions: 1,
    },
    {
      teacherId: 1,
      date: '2026-09-02',
      provinceName: 'Tây Ninh',
      periods: 1,
      sessions: 1,
    },
    {
      teacherId: 1,
      date: '2026-09-03',
      provinceName: 'Hồ Chí Minh',
      periods: 0,
      sessions: 1,
    },
    {
      teacherId: 2,
      date: '2026-09-06',
      provinceName: 'Hồ Chí Minh',
      periods: 3,
      sessions: 3,
    },
    {
      teacherId: 3,
      date: '2026-09-30',
      provinceName: 'Tây Ninh',
      periods: 2,
      sessions: 2,
    },
    // Dũng chưa có tiết nào và trường chưa khai phường → "chưa xác định".
    {
      teacherId: 4,
      date: '2026-09-10',
      provinceName: null,
      periods: 0,
      sessions: 1,
    },
  ],
  staffTeacherIds: new Set([2]),
  filterLabels: ['Giáo viên cộng tác viên'],
  exportedAt: new Date('2026-10-03T07:00:00Z'),
};

describe('buildAttendanceWorkbook', () => {
  const wb = buildAttendanceWorkbook(INPUT);

  it('sheet tổng hợp: xếp theo tên, tổng thanh toán là công thức tiết + xăng + chi phí khác', () => {
    const ws = wb.getWorksheet('Tổng hợp')!;
    expect(ws.getCell(2, 1).value).toContain('Từ 01/09/2026 đến 30/09/2026');
    expect(ws.getCell(2, 1).value).toContain('Giáo viên cộng tác viên');

    const names = [5, 6, 7, 8].map((r) => ws.getCell(r, 2).value);
    expect(names).toEqual([
      'Lê Thị An',
      'Trần Văn Bình',
      'Phạm Cường',
      'Ngô Dũng',
    ]);
    expect(ws.getCell(5, 3).value).toBe('Giáo viên công ty');
    expect(ws.getCell(6, 3).value).toBe('Giáo viên CTV');

    const header = (label: string) =>
      (ws.getRow(4).values as unknown[]).indexOf(label);
    const totalCol = header('Tổng thanh toán');
    const bình = ws.getCell(6, totalCol);
    expect((bình.value as any).formula).toMatch(/^[A-Z]+6\+[A-Z]+6\+[A-Z]+6$/);
    expect(shown(bình)).toBe(450000);

    const totalRow = findRow(ws, 'TỔNG CỘNG (4 giáo viên)');
    expect((ws.getCell(totalRow, totalCol).value as any).formula).toMatch(
      /^SUM\(/,
    );
    expect(shown(ws.getCell(totalRow, totalCol))).toBe(510000);
    expect(shown(ws.getCell(totalRow, header('Có dạy')))).toBe(9);
  });

  it('sheet tiết theo ngày: cột theo ngày có thứ, nhóm theo tỉnh dạy nhiều nhất, chưa xác định ở cuối', () => {
    const ws = wb.getWorksheet('Tiết theo ngày')!;
    // 30 ngày + 2 cột tên/chức vụ + 1 cột tổng.
    expect(ws.getCell(5, 3).value).toBe('01');
    expect(ws.getCell(6, 3).value).toBe('T3'); // 01/09/2026 là thứ Ba
    expect(ws.getCell(6, 8).value).toBe('CN'); // 06/09/2026
    expect(ws.getCell(5, 32).value).toBe('30');
    expect(ws.getCell(4, 33).value).toBe('TỔNG CÔNG');

    const hcm = findRow(ws, 'HỒ CHÍ MINH');
    const tayNinh = findRow(ws, 'TÂY NINH');
    const unknown = findRow(ws, UNKNOWN_PROVINCE.toUpperCase());
    expect(hcm).toBeLessThan(tayNinh);
    expect(tayNinh).toBeLessThan(unknown);

    expect(ws.getCell(hcm + 1, 1).value).toBe('Lê Thị An');
    expect(ws.getCell(hcm + 2, 1).value).toBe('Trần Văn Bình');
    const bình = hcm + 2;
    expect(ws.getCell(bình, 3).value).toBe(2);
    expect(ws.getCell(bình, 4).value).toBe(2); // 1 HCM + 1 Tây Ninh cùng ngày
    expect(ws.getCell(bình, 5).value).toBeNull(); // buổi chưa "Có dạy" không tính
    expect((ws.getCell(bình, 33).value as any).formula).toBe(
      `SUM(C${bình}:AF${bình})`,
    );
    expect(shown(ws.getCell(bình, 33))).toBe(4);
    expect(shown(ws.getCell(hcm, 33))).toBe(7);

    expect(ws.getCell(tayNinh + 1, 1).value).toBe('Phạm Cường');
    expect(ws.getCell(unknown + 1, 1).value).toBe('Ngô Dũng');
    // ExcelJS bỏ `result` = 0 khỏi công thức; Excel tự tính lại khi mở (fullCalcOnLoad).
    expect(shown(ws.getCell(unknown + 1, 33)) ?? 0).toBe(0);

    const total = findRow(ws, 'TỔNG CỘNG');
    expect((ws.getCell(total, 33).value as any).formula).toBe(
      `AG${hcm}+AG${tayNinh}+AG${unknown}`,
    );
    expect(shown(ws.getCell(total, 33))).toBe(9);
    expect(shown(ws.getCell(total, 3))).toBe(2);

    const notes: string[] = [];
    ws.eachRow((row) => {
      const v = row.getCell(1).value;
      if (typeof v === 'string' && v.startsWith('•')) notes.push(v);
    });
    expect(
      notes.some((n) => n.includes('Còn 2 buổi chưa chấm công (2 giáo viên)')),
    ).toBe(true);
  });

  it('khoảng ngày qua nhiều tháng thì ghi ngày kèm tháng', () => {
    const ws = buildAttendanceWorkbook({
      ...INPUT,
      fromDate: '2026-09-29',
      toDate: '2026-10-02',
    }).getWorksheet('Tiết theo ngày')!;
    expect(ws.getCell(4, 3).value).toBe('Ngày');
    expect(ws.getCell(5, 3).value).toBe('29/09');
    expect(ws.getCell(5, 6).value).toBe('02/10');
    expect(ws.getCell(4, 7).value).toBe('TỔNG CÔNG');
  });

  it('loại "daily" chỉ có sheet tiết theo ngày, cùng số liệu', () => {
    const daily = buildAttendanceWorkbook(INPUT, 'daily');
    expect(daily.worksheets.map((ws) => ws.name)).toEqual(['Tiết theo ngày']);
    const ws = daily.getWorksheet('Tiết theo ngày')!;
    expect(shown(ws.getCell(findRow(ws, 'TỔNG CỘNG'), 33))).toBe(9);
  });

  it('ghi ra được file xlsx hợp lệ và đọc lại đúng', async () => {
    const buffer = await wb.xlsx.writeBuffer();
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(buffer as ArrayBuffer);
    expect(reread.worksheets.map((ws) => ws.name)).toEqual([
      'Tổng hợp',
      'Tiết theo ngày',
    ]);
  });

  it('không có giáo viên nào vẫn dựng được file', () => {
    const empty = buildAttendanceWorkbook({ ...INPUT, rows: [], daily: [] });
    const ws = empty.getWorksheet('Tiết theo ngày')!;
    expect(ws.getCell(findRow(ws, 'TỔNG CỘNG'), 33).value).toBe(0);
  });
});

describe('compareVietnameseNames', () => {
  it('xếp theo tên rồi họ, đúng thứ tự chữ cái tiếng Việt', () => {
    const names = ['Đỗ Duy Đức', 'Lê Hoài An', 'Nguyễn Văn Dũng', 'Đỗ Duy An'];
    expect([...names].sort(compareVietnameseNames)).toEqual([
      'Đỗ Duy An',
      'Lê Hoài An',
      'Nguyễn Văn Dũng',
      'Đỗ Duy Đức',
    ]);
  });
});

describe('attendanceExportFileName', () => {
  it('file chỉ tiết theo ngày có tên riêng', () => {
    expect(
      attendanceExportFileName(
        {
          fromDate: '2026-09-01',
          toDate: '2026-09-30',
          teacherRole: TEACHER_COLLABORATOR_ROLE,
        },
        'daily',
      ),
    ).toBe('so-tiet-day-theo-ngay_2026-09-01_2026-09-30_gv-ctv.xlsx');
  });

  it('đặt tên theo khoảng ngày và loại giáo viên', () => {
    const base = { fromDate: '2026-09-01', toDate: '2026-09-30' };
    expect(attendanceExportFileName(base)).toBe(
      'tong-hop-cham-cong_2026-09-01_2026-09-30.xlsx',
    );
    expect(
      attendanceExportFileName({
        ...base,
        teacherRole: TEACHER_COLLABORATOR_ROLE,
      }),
    ).toBe('tong-hop-cham-cong_2026-09-01_2026-09-30_gv-ctv.xlsx');
    expect(
      attendanceExportFileName({ ...base, teacherRole: TEACHER_STAFF_ROLE }),
    ).toBe('tong-hop-cham-cong_2026-09-01_2026-09-30_gv-cong-ty.xlsx');
  });
});

describe('applyTeacherRoleFilter', () => {
  const makeQb = () => ({ andWhere: jest.fn() }) as any;

  it('giáo viên công ty → chỉ buổi của tài khoản có role giaovien_congty', () => {
    const qb = makeQb();
    applyTeacherRoleFilter(qb, TEACHER_STAFF_ROLE);
    expect(qb.andWhere).toHaveBeenCalledWith(STAFF_TEACHER_SQL);
  });

  it('cộng tác viên → mọi giáo viên không phải giáo viên công ty', () => {
    const qb = makeQb();
    applyTeacherRoleFilter(qb, TEACHER_COLLABORATOR_ROLE);
    expect(qb.andWhere).toHaveBeenCalledWith(`NOT ${STAFF_TEACHER_SQL}`);
  });

  it('không chọn loại → không lọc', () => {
    const qb = makeQb();
    applyTeacherRoleFilter(qb, undefined);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });
});

describe('AttendanceExportService', () => {
  it('từ chối khoảng quá 366 ngày trước khi truy vấn', async () => {
    const sessionService = { attendanceSummary: jest.fn() };
    const service = new AttendanceExportService(
      sessionService as any,
      {} as any,
    );
    await expect(
      service.exportAttendanceSummary({
        fromDate: '2026-01-01',
        toDate: '2027-01-02',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessionService.attendanceSummary).not.toHaveBeenCalled();
  });

  it('từ chối khoảng ngày ngược', async () => {
    const service = new AttendanceExportService({} as any, {} as any);
    await expect(
      service.exportAttendanceSummary({
        fromDate: '2026-09-30',
        toDate: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GET /teaching-sessions/attendance/summary/export', () => {
  let app: INestApplication;
  const exporter = {
    exportAttendanceSummary: jest.fn().mockResolvedValue({
      buffer: Buffer.from('xlsx-bytes'),
      fileName: 'tong-hop-cham-cong_2026-09-01_2026-09-30_gv-ctv.xlsx',
    }),
  };
  const allow: CanActivate = {
    canActivate: (context) => {
      context.switchToHttp().getRequest().user = { id: 1, roles: ['nhansu'] };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TeachingSessionController],
      providers: [
        { provide: TeachingSessionService, useValue: {} },
        { provide: TeachingBulkService, useValue: {} },
        { provide: LessonImageLibraryService, useValue: {} },
        { provide: AttendanceExportService, useValue: exporter },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(RolesGuard)
      .useValue(allow)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app?.close());

  it('trả file xlsx kèm tên file, chuyển đúng bộ lọc (kể cả teacherRole)', async () => {
    const res = await request(app.getHttpServer())
      .get('/teaching-sessions/attendance/summary/export')
      .query({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        teacherRole: TEACHER_COLLABORATOR_ROLE,
        schoolId: '563',
      })
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(
      'filename="tong-hop-cham-cong_2026-09-01_2026-09-30_gv-ctv.xlsx"',
    );
    expect((res.body as Buffer).toString()).toBe('xlsx-bytes');
    expect(exporter.exportAttendanceSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        teacherRole: TEACHER_COLLABORATOR_ROLE,
        schoolId: 563,
      }),
    );
  });

  it('endpoint số tiết theo ngày gọi service với loại "daily"', async () => {
    exporter.exportAttendanceSummary.mockClear();
    const res = await request(app.getHttpServer())
      .get('/teaching-sessions/attendance/daily-periods/export')
      .query({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        teacherRole: TEACHER_COLLABORATOR_ROLE,
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(exporter.exportAttendanceSummary).toHaveBeenCalledWith(
      expect.objectContaining({ teacherRole: TEACHER_COLLABORATOR_ROLE }),
      'daily',
    );
  });

  it('từ chối teacherRole lạ', async () => {
    const res = await request(app.getHttpServer())
      .get('/teaching-sessions/attendance/summary/export')
      .query({
        fromDate: '2026-09-01',
        toDate: '2026-09-30',
        teacherRole: 'admin',
      });
    expect(res.status).toBe(400);
  });
});
