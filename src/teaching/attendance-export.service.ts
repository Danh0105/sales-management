import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as ExcelJS from 'exceljs';
import { Repository } from 'typeorm';
import { TeachingSession } from './entities/teaching-session.entity';
import { QueryAttendanceSummaryDto } from './dto/teaching-session.dto';
import { SessionStatus } from './teaching.enum';
import {
  TEACHER_COLLABORATOR_ROLE,
  TEACHER_STAFF_ROLE,
} from './teaching-roles';
import {
  applyTeacherRoleFilter,
  TeachingSessionService,
} from './teaching-session.service';
import {
  addDays,
  assertDateOrder,
  dayOfWeekOf,
  toDateString,
} from './teaching.util';

/** Sheet "Tiết theo ngày" có một cột mỗi ngày — quá một năm thì không còn đọc được. */
export const ATTENDANCE_EXPORT_MAX_DAYS = 366;

export const UNKNOWN_PROVINCE = 'Chưa xác định tỉnh';

/**
 * `summary`: file đầy đủ (sheet tổng hợp + sheet tiết theo ngày).
 * `daily`: chỉ sheet số tiết theo ngày — bảng công gửi đi đối chiếu, không kèm tiền.
 */
export type AttendanceExportKind = 'summary' | 'daily';

type SummaryResult = Awaited<
  ReturnType<TeachingSessionService['attendanceSummary']>
>;
export type AttendanceSummaryRow = SummaryResult['data'][number];

/** Số tiết "Có dạy" của một giáo viên trong một ngày, tại một tỉnh. */
export interface DailyPeriodsRow {
  teacherId: number;
  date: string;
  provinceName: string | null;
  periods: number;
  sessions: number;
}

export interface AttendanceWorkbookInput {
  fromDate: string;
  toDate: string;
  rows: AttendanceSummaryRow[];
  daily: DailyPeriodsRow[];
  staffTeacherIds: Set<number>;
  /** Mô tả bộ lọc đang áp dụng, in dưới tiêu đề mỗi sheet. */
  filterLabels: string[];
  exportedAt: Date;
}

const FONT = 'Arial';
const BORDER_COLOR = { argb: 'FF9CA3AF' };
const THIN = { style: 'thin' as const, color: BORDER_COLOR };
const BORDER: Partial<ExcelJS.Borders> = {
  top: THIN,
  left: THIN,
  bottom: THIN,
  right: THIN,
};
const fill = (argb: string): ExcelJS.Fill => ({
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb },
});
const HEADER_FILL = fill('FFFFF2A8');
const GROUP_FILL = fill('FFFFF7CC');
const TOTAL_FILL = fill('FFDCE6F2');
const SUNDAY_FILL = fill('FFEDEDED');
const MONEY = '#,##0;-#,##0;"-"';
const COUNT = '#,##0;-#,##0;"-"';
/** Ô tiết theo ngày để trống khi 0 cho dễ nhìn, giống bảng công giấy. */
const DAY_COUNT = '0;-0;""';

const collator = new Intl.Collator('vi', { sensitivity: 'base' });

/** Xếp theo tên (chữ cuối) rồi cả họ tên — thói quen đọc danh sách tiếng Việt. */
export function compareVietnameseNames(a: string, b: string): number {
  const given = (name: string) => name.trim().split(/\s+/).pop() ?? '';
  return collator.compare(given(a), given(b)) || collator.compare(a, b);
}

const teacherTypeLabel = (staff: boolean) =>
  staff ? 'Giáo viên công ty' : 'Giáo viên CTV';

const formatVnDate = (date: string) => date.split('-').reverse().join('/');

const weekdayLabel = (date: string) => {
  const day = dayOfWeekOf(date);
  return day === 8 ? 'CN' : `T${day}`;
};

function listDates(fromDate: string, toDate: string): string[] {
  const dates: string[] = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) dates.push(d);
  return dates;
}

/** Tỉnh dạy nhiều tiết nhất; chưa có tiết nào thì lấy tỉnh có nhiều buổi nhất. */
function mainProvinceByTeacher(daily: DailyPeriodsRow[]): Map<number, string> {
  const weights = new Map<number, Map<string, [number, number]>>();
  for (const row of daily) {
    if (!row.provinceName) continue;
    const byProvince = weights.get(row.teacherId) ?? new Map();
    const [periods, sessions] = byProvince.get(row.provinceName) ?? [0, 0];
    byProvince.set(row.provinceName, [
      periods + row.periods,
      sessions + row.sessions,
    ]);
    weights.set(row.teacherId, byProvince);
  }

  const result = new Map<number, string>();
  for (const [teacherId, byProvince] of weights) {
    const [best] = [...byProvince.entries()].sort(
      ([nameA, [pA, sA]], [nameB, [pB, sB]]) =>
        pB - pA || sB - sA || collator.compare(nameA, nameB),
    );
    result.set(teacherId, best[0]);
  }
  return result;
}

function styleCell(
  cell: ExcelJS.Cell,
  options: {
    bold?: boolean;
    fill?: ExcelJS.Fill;
    numFmt?: string;
    align?: ExcelJS.Alignment['horizontal'];
  } = {},
) {
  cell.font = { name: FONT, size: 10, bold: options.bold };
  cell.border = BORDER;
  if (options.fill) cell.fill = options.fill;
  if (options.numFmt) cell.numFmt = options.numFmt;
  cell.alignment = {
    vertical: 'middle',
    horizontal: options.align,
    wrapText: true,
  };
}

function put(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: ExcelJS.CellValue,
  options: Parameters<typeof styleCell>[1] = {},
): ExcelJS.Cell {
  const cell = ws.getCell(row, col);
  cell.value = value;
  styleCell(cell, options);
  return cell;
}

function writeTitle(
  ws: ExcelJS.Worksheet,
  title: string,
  lastColumn: number,
  input: AttendanceWorkbookInput,
) {
  ws.mergeCells(1, 1, 1, lastColumn);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: FONT, size: 14, bold: true };
  titleCell.alignment = { horizontal: 'center' };

  ws.mergeCells(2, 1, 2, lastColumn);
  const subtitle = ws.getCell(2, 1);
  const exported = input.exportedAt.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  subtitle.value = [
    `Từ ${formatVnDate(input.fromDate)} đến ${formatVnDate(input.toDate)}`,
    ...input.filterLabels,
    `Xuất lúc ${exported}`,
  ].join(' · ');
  subtitle.font = {
    name: FONT,
    size: 10,
    italic: true,
    color: { argb: 'FF555555' },
  };
  subtitle.alignment = { horizontal: 'center' };
}

const SUMMARY_COLUMNS: {
  header: string;
  width: number;
  numFmt?: string;
  value?: (row: AttendanceSummaryRow) => number;
}[] = [
  {
    header: 'Tổng buổi',
    width: 9,
    numFmt: COUNT,
    value: (r) => r.totalSessions,
  },
  { header: 'Có dạy', width: 9, numFmt: COUNT, value: (r) => r.present },
  { header: 'Vắng', width: 8, numFmt: COUNT, value: (r) => r.absent },
  { header: 'Nghỉ phép', width: 9, numFmt: COUNT, value: (r) => r.excused },
  { header: 'Huỷ', width: 8, numFmt: COUNT, value: (r) => r.cancelled },
  { header: 'Chưa chấm', width: 9, numFmt: COUNT, value: (r) => r.unchecked },
  { header: 'Dạy bù', width: 8, numFmt: COUNT, value: (r) => r.makeup },
  {
    header: 'Tổng tiết',
    width: 9,
    numFmt: COUNT,
    value: (r) => r.totalPeriods,
  },
  {
    header: 'Tiết tính công',
    width: 10,
    numFmt: COUNT,
    value: (r) => r.payablePeriods,
  },
  {
    header: 'Tiền tiết dạy',
    width: 14,
    numFmt: MONEY,
    value: (r) => r.payableAmount,
  },
  {
    header: 'Phụ cấp xăng',
    width: 13,
    numFmt: MONEY,
    value: (r) => r.fuelAllowanceAmount,
  },
  {
    header: 'Số km',
    width: 9,
    numFmt: '#,##0.0;-#,##0.0;"-"',
    value: (r) => r.totalDistanceKm,
  },
  {
    header: 'Chi phí khác',
    width: 13,
    numFmt: MONEY,
    value: (r) => r.otherCostsAmount,
  },
  // Công thức, không lấy số backend: cột tổng phải tự khớp khi sửa tay các ô tiền.
  { header: 'Tổng thanh toán', width: 15, numFmt: MONEY },
  {
    header: 'Thiếu giá (buổi)',
    width: 10,
    numFmt: COUNT,
    value: (r) => r.missingRateSessions,
  },
];

function buildSummarySheet(
  wb: ExcelJS.Workbook,
  input: AttendanceWorkbookInput,
) {
  const firstValueCol = 4;
  const lastCol = firstValueCol + SUMMARY_COLUMNS.length - 1;
  const ws = wb.addWorksheet('Tổng hợp', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
  });
  writeTitle(ws, 'BẢNG TỔNG HỢP CHẤM CÔNG GIÁO VIÊN', lastCol, input);

  const headerRow = 4;
  [
    'STT',
    'Giáo viên',
    'Loại giáo viên',
    ...SUMMARY_COLUMNS.map((c) => c.header),
  ].forEach((header, index) => {
    const cell = ws.getCell(headerRow, index + 1);
    cell.value = header;
    styleCell(cell, { bold: true, fill: HEADER_FILL, align: 'center' });
  });
  ws.getRow(headerRow).height = 30;
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 28;
  ws.getColumn(3).width = 17;
  SUMMARY_COLUMNS.forEach(
    (c, i) => (ws.getColumn(firstValueCol + i).width = c.width),
  );

  const col = (header: string) =>
    ws.getColumn(
      firstValueCol + SUMMARY_COLUMNS.findIndex((c) => c.header === header),
    ).letter;
  const [payCol, fuelCol, otherCol] = [
    col('Tiền tiết dạy'),
    col('Phụ cấp xăng'),
    col('Chi phí khác'),
  ];

  const rows = [...input.rows].sort((a, b) =>
    compareVietnameseNames(a.teacherName, b.teacherName),
  );
  const firstDataRow = headerRow + 1;
  rows.forEach((row, index) => {
    const r = firstDataRow + index;
    put(ws, r, 1, index + 1, { align: 'center' });
    put(ws, r, 2, row.teacherName);
    put(ws, r, 3, teacherTypeLabel(input.staffTeacherIds.has(row.teacherId)), {
      align: 'center',
    });
    SUMMARY_COLUMNS.forEach((column, i) => {
      const cell = ws.getCell(r, firstValueCol + i);
      cell.value = column.value
        ? column.value(row)
        : {
            formula: `${payCol}${r}+${fuelCol}${r}+${otherCol}${r}`,
            result:
              row.payableAmount +
              row.fuelAllowanceAmount +
              row.otherCostsAmount,
          };
      styleCell(cell, {
        numFmt: column.numFmt,
        align: 'right',
        bold: !column.value,
      });
    });
  });

  const totalRow = firstDataRow + rows.length;
  ws.mergeCells(totalRow, 1, totalRow, 3);
  put(ws, totalRow, 1, `TỔNG CỘNG (${rows.length} giáo viên)`, {
    bold: true,
    fill: TOTAL_FILL,
    align: 'center',
  });
  SUMMARY_COLUMNS.forEach((column, i) => {
    const c = firstValueCol + i;
    const letter = ws.getColumn(c).letter;
    const result = rows.reduce(
      (sum, row) =>
        sum +
        (column.value
          ? column.value(row)
          : row.payableAmount + row.fuelAllowanceAmount + row.otherCostsAmount),
      0,
    );
    const cell = ws.getCell(totalRow, c);
    cell.value =
      rows.length > 0
        ? {
            formula: `SUM(${letter}${firstDataRow}:${letter}${totalRow - 1})`,
            result,
          }
        : 0;
    styleCell(cell, {
      bold: true,
      fill: TOTAL_FILL,
      numFmt: column.numFmt,
      align: 'right',
    });
  });

  const notes = [
    'Tổng thanh toán = Tiền tiết dạy + Phụ cấp xăng + Chi phí khác. Chỉ buổi “Có dạy” mới tính tiền.',
    'Giáo viên công ty nhận lương + phụ cấp xăng nên không có tiền tiết dạy. Cộng tác viên là mọi giáo viên không phải giáo viên công ty.',
  ];
  const missing = rows.reduce((sum, row) => sum + row.missingRateSessions, 0);
  if (missing > 0) {
    notes.push(
      `Còn ${missing} buổi đã dạy chưa khai đơn giá — Tiền tiết dạy đang thiếu phần này.`,
    );
  }
  writeNotes(ws, totalRow + 2, notes);
}

function buildDailySheet(wb: ExcelJS.Workbook, input: AttendanceWorkbookInput) {
  const dates = listDates(input.fromDate, input.toDate);
  const sameMonth = input.fromDate.slice(0, 7) === input.toDate.slice(0, 7);
  const firstDayCol = 3;
  const lastDayCol = firstDayCol + dates.length - 1;
  const totalCol = lastDayCol + 1;
  const ws = wb.addWorksheet('Tiết theo ngày', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 6 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '4:6',
    },
  });
  writeTitle(ws, 'BẢNG SỐ TIẾT DẠY THEO NGÀY', totalCol, input);

  const [h1, h2, h3] = [4, 5, 6];
  for (const [c, label] of [
    [1, 'Họ và tên'],
    [2, 'Chức vụ'],
    [totalCol, 'TỔNG CÔNG'],
  ] as const) {
    ws.mergeCells(h1, c, h3, c);
    ws.getCell(h1, c).value = label;
  }
  ws.mergeCells(h1, firstDayCol, h1, lastDayCol);
  ws.getCell(h1, firstDayCol).value = sameMonth ? 'Ngày trong tháng' : 'Ngày';
  dates.forEach((date, i) => {
    const [, month, day] = date.split('-');
    ws.getCell(h2, firstDayCol + i).value = sameMonth ? day : `${day}/${month}`;
    ws.getCell(h3, firstDayCol + i).value = weekdayLabel(date);
  });
  for (const r of [h1, h2, h3]) {
    for (let c = 1; c <= totalCol; c++) {
      styleCell(ws.getCell(r, c), {
        bold: true,
        fill: HEADER_FILL,
        align: 'center',
      });
    }
  }
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 17;
  for (let c = firstDayCol; c <= lastDayCol; c++) {
    ws.getColumn(c).width = sameMonth ? 4.5 : 6;
  }
  ws.getColumn(totalCol).width = 11;
  const sundayCols = new Set(
    dates.flatMap((date, i) =>
      weekdayLabel(date) === 'CN' ? [firstDayCol + i] : [],
    ),
  );

  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const periodsByTeacher = new Map<number, number[]>();
  for (const row of input.daily) {
    const index = dateIndex.get(row.date);
    if (index === undefined || row.periods <= 0) continue;
    const days =
      periodsByTeacher.get(row.teacherId) ?? new Array(dates.length).fill(0);
    days[index] += row.periods;
    periodsByTeacher.set(row.teacherId, days);
  }

  const provinceOf = mainProvinceByTeacher(input.daily);
  const groups = new Map<string, AttendanceSummaryRow[]>();
  for (const row of input.rows) {
    const province = provinceOf.get(row.teacherId) ?? UNKNOWN_PROVINCE;
    groups.set(province, [...(groups.get(province) ?? []), row]);
  }
  // Nhóm đông giáo viên lên trước, "chưa xác định" luôn cuối.
  const groupNames = [...groups.keys()].sort(
    (a, b) =>
      Number(a === UNKNOWN_PROVINCE) - Number(b === UNKNOWN_PROVINCE) ||
      groups.get(b)!.length - groups.get(a)!.length ||
      collator.compare(a, b),
  );

  const dayStyle = (
    c: number,
    extra: { bold?: boolean; fill?: ExcelJS.Fill } = {},
  ) => ({
    align: 'center' as const,
    numFmt: DAY_COUNT,
    ...extra,
    fill: extra.fill ?? (sundayCols.has(c) ? SUNDAY_FILL : undefined),
  });

  let r = h3 + 1;
  const groupRows: { row: number; totals: number[] }[] = [];
  for (const name of groupNames) {
    const teachers = groups
      .get(name)!
      .sort((a, b) => compareVietnameseNames(a.teacherName, b.teacherName));
    const groupRow = r;
    const first = groupRow + 1;
    const last = groupRow + teachers.length;
    const totals = new Array(dates.length + 1).fill(0);

    r = first;
    for (const teacher of teachers) {
      const days =
        periodsByTeacher.get(teacher.teacherId) ??
        new Array(dates.length).fill(0);
      put(ws, r, 1, teacher.teacherName);
      put(
        ws,
        r,
        2,
        teacherTypeLabel(input.staffTeacherIds.has(teacher.teacherId)),
        { align: 'center' },
      );
      days.forEach((periods, i) => {
        const cell = ws.getCell(r, firstDayCol + i);
        if (periods) cell.value = periods;
        totals[i] += periods;
        styleCell(cell, dayStyle(firstDayCol + i));
      });
      const rowTotal = days.reduce((sum, v) => sum + v, 0);
      totals[dates.length] += rowTotal;
      const totalCell = ws.getCell(r, totalCol);
      totalCell.value = {
        formula: `SUM(${ws.getColumn(firstDayCol).letter}${r}:${ws.getColumn(lastDayCol).letter}${r})`,
        result: rowTotal,
      };
      styleCell(totalCell, { bold: true, align: 'center', numFmt: COUNT });
      r++;
    }

    put(ws, groupRow, 1, name.toUpperCase(), {
      bold: true,
      fill: GROUP_FILL,
      align: 'center',
    });
    styleCell(ws.getCell(groupRow, 2), { fill: GROUP_FILL });
    for (let c = firstDayCol; c <= totalCol; c++) {
      const letter = ws.getColumn(c).letter;
      const cell = ws.getCell(groupRow, c);
      cell.value = {
        formula: `SUM(${letter}${first}:${letter}${last})`,
        result: totals[c - firstDayCol],
      };
      styleCell(cell, {
        bold: true,
        fill: GROUP_FILL,
        align: 'center',
        numFmt: c === totalCol ? COUNT : DAY_COUNT,
      });
    }
    groupRows.push({ row: groupRow, totals });
  }

  const totalRow = r;
  put(ws, totalRow, 1, 'TỔNG CỘNG', {
    bold: true,
    fill: TOTAL_FILL,
    align: 'center',
  });
  styleCell(ws.getCell(totalRow, 2), { fill: TOTAL_FILL });
  for (let c = firstDayCol; c <= totalCol; c++) {
    const letter = ws.getColumn(c).letter;
    const cell = ws.getCell(totalRow, c);
    const result = groupRows.reduce(
      (sum, g) => sum + g.totals[c - firstDayCol],
      0,
    );
    cell.value = groupRows.length
      ? { formula: groupRows.map((g) => `${letter}${g.row}`).join('+'), result }
      : 0;
    styleCell(cell, {
      bold: true,
      fill: TOTAL_FILL,
      align: 'center',
      numFmt: c === totalCol ? COUNT : DAY_COUNT,
    });
  }

  const notes = [
    'Mỗi ô là số tiết của các buổi đã chấm “Có dạy” trong ngày. Buổi vắng, nghỉ phép, huỷ, chưa chấm không tính.',
    'Giáo viên xếp vào nhóm tỉnh nơi dạy nhiều tiết nhất trong khoảng (theo phường của trường); số tiết ở mọi tỉnh đều nằm trên dòng của giáo viên.',
  ];
  const unchecked = input.rows.filter((row) => row.unchecked > 0);
  if (unchecked.length > 0) {
    const sessions = unchecked.reduce((sum, row) => sum + row.unchecked, 0);
    notes.push(
      `Còn ${sessions} buổi chưa chấm công (${unchecked.length} giáo viên) — chưa tính vào bảng.`,
    );
  }
  writeNotes(ws, totalRow + 2, notes);
}

function writeNotes(ws: ExcelJS.Worksheet, startRow: number, notes: string[]) {
  const head = ws.getCell(startRow, 1);
  head.value = 'Ghi chú:';
  head.font = { name: FONT, size: 10, bold: true };
  notes.forEach((note, i) => {
    const cell = ws.getCell(startRow + 1 + i, 1);
    cell.value = `• ${note}`;
    cell.font = { name: FONT, size: 10, italic: true };
  });
}

/** Dựng workbook từ dữ liệu đã truy vấn — tách riêng để test không cần DB. */
export function buildAttendanceWorkbook(
  input: AttendanceWorkbookInput,
  kind: AttendanceExportKind = 'summary',
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Kido Office';
  wb.created = input.exportedAt;
  // Kèm `result` cho mọi công thức để xem trước được ngay, nhưng vẫn bắt
  // Excel tính lại khi mở cho chắc.
  wb.calcProperties.fullCalcOnLoad = true;
  if (kind === 'summary') buildSummarySheet(wb, input);
  buildDailySheet(wb, input);
  return wb;
}

export function attendanceExportFileName(
  query: QueryAttendanceSummaryDto,
  kind: AttendanceExportKind = 'summary',
): string {
  const suffix =
    query.teacherRole === TEACHER_STAFF_ROLE
      ? '_gv-cong-ty'
      : query.teacherRole === TEACHER_COLLABORATOR_ROLE
        ? '_gv-ctv'
        : '';
  const prefix =
    kind === 'daily' ? 'so-tiet-day-theo-ngay' : 'tong-hop-cham-cong';
  return `${prefix}_${query.fromDate}_${query.toDate}${suffix}.xlsx`;
}

@Injectable()
export class AttendanceExportService {
  constructor(
    private readonly sessionService: TeachingSessionService,
    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,
  ) {}

  /** File Excel của bảng tổng hợp chấm công, cùng bộ lọc với màn hình. */
  async exportAttendanceSummary(
    query: QueryAttendanceSummaryDto,
    kind: AttendanceExportKind = 'summary',
  ): Promise<{ buffer: Buffer; fileName: string }> {
    assertDateOrder(
      query.fromDate,
      query.toDate,
      'fromDate phải nhỏ hơn hoặc bằng toDate',
    );
    const days = listDates(query.fromDate, query.toDate).length;
    if (days > ATTENDANCE_EXPORT_MAX_DAYS) {
      throw new BadRequestException(
        `Chỉ xuất được tối đa ${ATTENDANCE_EXPORT_MAX_DAYS} ngày một lần (đang chọn ${days} ngày)`,
      );
    }

    const [summary, daily] = await Promise.all([
      this.sessionService.attendanceSummary(query),
      this.loadDailyPeriods(query),
    ]);
    const teacherIds = summary.data.map((row) => row.teacherId);
    const [staffTeacherIds, filterLabels] = await Promise.all([
      this.loadStaffTeacherIds(teacherIds),
      this.describeFilters(query),
    ]);

    const wb = buildAttendanceWorkbook(
      {
        fromDate: query.fromDate,
        toDate: query.toDate,
        rows: summary.data,
        daily,
        staffTeacherIds,
        filterLabels,
        exportedAt: new Date(),
      },
      kind,
    );
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, fileName: attendanceExportFileName(query, kind) };
  }

  /** Tiết "Có dạy" theo giáo viên × ngày × tỉnh của trường, cùng bộ lọc với bảng tổng hợp. */
  private async loadDailyPeriods(
    query: QueryAttendanceSummaryDto,
  ): Promise<DailyPeriodsRow[]> {
    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .leftJoin('ss.school', 'sc')
      .leftJoin('sc.ward', 'sw')
      .leftJoin('sw.province', 'sp')
      .select('ss.teacherId', 'teacherId')
      .addSelect('ss.date', 'date')
      .addSelect('sp.name', 'provinceName')
      .addSelect(
        `COALESCE(SUM(COALESCE(ss.periods, 1))
                    FILTER (WHERE ss.status = '${SessionStatus.PRESENT}'), 0)`,
        'periods',
      )
      .addSelect('COUNT(*)', 'sessions')
      .where('ss.date >= :fromDate', { fromDate: query.fromDate })
      .andWhere('ss.date <= :toDate', { toDate: query.toDate })
      .andWhere('ss.teacherId IS NOT NULL')
      .groupBy('ss.teacherId')
      .addGroupBy('ss.date')
      .addGroupBy('sp.name');

    if (query.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: query.teacherId });
    }
    if (query.schoolId) {
      qb.andWhere('ss.schoolId = :schoolId', { schoolId: query.schoolId });
    }
    if (query.classId) {
      qb.andWhere('ss.classId = :classId', { classId: query.classId });
    }
    applyTeacherRoleFilter(qb, query.teacherRole);

    const rows = await qb.getRawMany();
    return rows.map((row) => ({
      teacherId: Number(row.teacherId),
      date: toDateString(row.date) as string,
      provinceName: row.provinceName ?? null,
      periods: Number(row.periods),
      sessions: Number(row.sessions),
    }));
  }

  private async loadStaffTeacherIds(
    teacherIds: number[],
  ): Promise<Set<number>> {
    if (teacherIds.length === 0) return new Set();
    const rows: { id: number }[] = await this.sessionRepo.manager.query(
      `SELECT t.id FROM teachers t JOIN employee e ON e.id = t.employee_id
        WHERE t.id = ANY($1) AND $2 = ANY(e.roles)`,
      [teacherIds, TEACHER_STAFF_ROLE],
    );
    return new Set(rows.map((row) => Number(row.id)));
  }

  private async describeFilters(
    query: QueryAttendanceSummaryDto,
  ): Promise<string[]> {
    const nameOf = async (table: string, id?: number) => {
      if (!id) return null;
      const [row] = await this.sessionRepo.manager.query(
        `SELECT name FROM ${table} WHERE id = $1`,
        [id],
      );
      return (row?.name as string | undefined) ?? `#${id}`;
    };
    const [teacher, school, schoolClass] = await Promise.all([
      nameOf('teachers', query.teacherId),
      nameOf('schools', query.schoolId),
      nameOf('school_classes', query.classId),
    ]);

    const labels: string[] = [];
    if (query.teacherRole === TEACHER_STAFF_ROLE)
      labels.push('Giáo viên công ty');
    if (query.teacherRole === TEACHER_COLLABORATOR_ROLE)
      labels.push('Giáo viên cộng tác viên');
    if (teacher) labels.push(`Giáo viên: ${teacher}`);
    if (school) labels.push(`Trường: ${school}`);
    if (schoolClass) labels.push(`Lớp: ${schoolClass}`);
    return labels;
  }
}
