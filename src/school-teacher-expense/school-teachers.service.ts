import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { SchoolTeacher } from './school-teacher.entity';

const text = (value: unknown, max: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new BadRequestException(`${field} tối đa ${max} ký tự`);
  }
  return trimmed;
};

const intOrNull = (value: unknown) => {
  if (value === undefined || value === null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
};

type PayrollQuery = {
  year?: unknown;
  month?: unknown;
  schoolId?: unknown;
  schoolExpenseId?: unknown;
};

type PayrollRow = {
  id: number;
  school_expense_id: number;
  subject_id: number;
  row_index: number;
  content: string | null;
  total_periods: string;
  student_count: string;
  months_count: string;
  unit_price: string;
  amount: string;
  pit_rate: string;
  pit_amount: string;
  net_amount: string;
  expense_date: string | null;
  cash_account: string | null;
  school_teacher_id: number | null;
  teacher_name: string | null;
  bank_account: string | null;
  bank_name: string | null;
  tax_code: string | null;
  school_id: number;
  school_name: string;
  period_id: number;
  period_month: number;
  period_year: number;
  period_name: string | null;
  subject_name: string;
  revenue_content: string | null;
};

/**
 * Danh sách giáo viên của trường (nhận lương ở bảng Giáo viên trường) và báo
 * cáo "Lương giáo viên trường" theo tháng: gộp các dòng của mọi môn theo giáo
 * viên, kèm số tài khoản / MST để chi trả.
 */
@Injectable()
export class SchoolTeachersService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private get repo() {
    return this.dataSource.getRepository(SchoolTeacher);
  }

  async list(schoolId: number) {
    if (!Number.isInteger(schoolId) || schoolId <= 0) {
      throw new BadRequestException('schoolId is required');
    }
    return this.repo.find({
      where: { schoolId },
      order: { isActive: 'DESC', name: 'ASC', id: 'ASC' },
    });
  }

  private normalize(body: any) {
    return {
      bankAccount: text(body?.bankAccount, 50, 'Số tài khoản'),
      bankName: text(body?.bankName, 100, 'Ngân hàng'),
      taxCode: text(body?.taxCode, 20, 'Mã số thuế'),
      note: text(body?.note, 2000, 'Ghi chú'),
    };
  }

  async create(body: any) {
    const schoolId = intOrNull(body?.schoolId);
    if (!schoolId) throw new BadRequestException('Chọn trường của giáo viên');
    const name = text(body?.name, 255, 'Tên giáo viên');
    if (!name) throw new BadRequestException('Nhập tên giáo viên');
    const [school] = await this.dataSource.query<{ id: number }[]>(
      `SELECT id FROM schools WHERE id = $1`,
      [schoolId],
    );
    if (!school) throw new NotFoundException('Trường không tồn tại');
    return this.repo.save(
      this.repo.create({ schoolId, name, isActive: true, ...this.normalize(body) }),
    );
  }

  async update(id: number, body: any) {
    const teacher = await this.repo.findOne({ where: { id } });
    if (!teacher) throw new NotFoundException('Không tìm thấy giáo viên');
    if (body?.name !== undefined) {
      const name = text(body.name, 255, 'Tên giáo viên');
      if (!name) throw new BadRequestException('Nhập tên giáo viên');
      teacher.name = name;
    }
    const normalized = this.normalize(body);
    for (const key of ['bankAccount', 'bankName', 'taxCode', 'note'] as const) {
      if (body?.[key] !== undefined) teacher[key] = normalized[key];
    }
    if (body?.isActive !== undefined) teacher.isActive = !!body.isActive;
    return this.repo.save(teacher);
  }

  /** Ngừng dùng (ẩn khỏi ô chọn); không xoá để kỳ cũ vẫn hiện tên. */
  async deactivate(id: number) {
    return this.update(id, { isActive: false });
  }

  /**
   * Báo cáo lương giáo viên trường: theo bảng thu chi (trường × kỳ), mỗi giáo
   * viên một dòng gộp mọi môn; dòng chưa chọn giáo viên gom vào "Chưa chọn".
   */
  async payrollReport(query: PayrollQuery) {
    const year = intOrNull(query.year);
    const month = intOrNull(query.month);
    const schoolId = intOrNull(query.schoolId);
    const schoolExpenseId = intOrNull(query.schoolExpenseId);
    if ([year, month, schoolId, schoolExpenseId].some((value) => Number.isNaN(value))) {
      throw new BadRequestException('Bộ lọc không hợp lệ');
    }
    if (!schoolExpenseId && !(year && month)) {
      throw new BadRequestException('Chọn tháng (năm + tháng) hoặc một bảng thu chi');
    }

    const params: unknown[] = [];
    const where: string[] = ['t.amount > 0'];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (schoolExpenseId) add('t.school_expense_id = ?', schoolExpenseId);
    if (schoolId) add('se.school_id = ?', schoolId);
    if (year) add('ep.year = ?', year);
    if (month) add('ep.month = ?', month);

    const rows = await this.dataSource.query<PayrollRow[]>(
      `SELECT t.id, t.school_expense_id, t.subject_id, t.row_index, t.content,
         t.total_periods::text, t.student_count::text, t.months_count::text,
         t.unit_price::text, t.amount::text, t.pit_rate::text, t.pit_amount::text,
         t.net_amount::text, to_char(t.expense_date, 'YYYY-MM-DD') AS expense_date,
         t.cash_account, t.school_teacher_id,
         st.name AS teacher_name, st.bank_account, st.bank_name, st.tax_code,
         se.school_id, s.name AS school_name,
         ep.id AS period_id, ep.month AS period_month, ep.year AS period_year,
         ep.name AS period_name,
         COALESCE(cat.name, sub.name) AS subject_name,
         rev.content AS revenue_content
       FROM school_teacher_expense_items t
       JOIN school_expenses se ON se.id = t.school_expense_id
       JOIN schools s ON s.id = se.school_id
       JOIN expense_periods ep ON ep.id = se.period_id
       JOIN subjects sub ON sub.id = t.subject_id
       LEFT JOIN subject_catalogs cat ON cat.id = sub.catalog_id
       LEFT JOIN school_teachers st ON st.id = t.school_teacher_id
       LEFT JOIN LATERAL (
         SELECT r.content FROM revenue_items r
         WHERE r.school_expense_id = t.school_expense_id
           AND r.subject_id = t.subject_id AND r."rowIndex" = t.row_index
         ORDER BY r.id LIMIT 1
       ) rev ON true
       WHERE ${where.join(' AND ')}
       ORDER BY s.name, ep.year, ep.month, st.name NULLS LAST, subject_name, t.row_index, t.id`,
      params,
    );

    const approvals = await this.dataSource.query<
      { school_expense_id: number; subject_id: number; approved_by_name: string | null; approved_at: string }[]
    >(
      `SELECT school_expense_id, subject_id, approved_by_name, approved_at
       FROM school_teacher_payroll_approvals
       WHERE school_expense_id = ANY($1)`,
      [[...new Set(rows.map((row) => row.school_expense_id))]],
    );

    const money = (value: string | null) => Number(value || 0);
    const sheets = new Map<number, any>();
    for (const row of rows) {
      let sheet = sheets.get(row.school_expense_id);
      if (!sheet) {
        sheet = {
          schoolExpenseId: row.school_expense_id,
          schoolId: row.school_id,
          schoolName: row.school_name,
          period: {
            id: row.period_id,
            month: row.period_month,
            year: row.period_year,
            name: row.period_name,
          },
          approvals: approvals
            .filter((a) => a.school_expense_id === row.school_expense_id)
            .map((a) => ({
              subjectId: a.subject_id,
              approvedByName: a.approved_by_name,
              approvedAt: a.approved_at,
            })),
          teacherMap: new Map<string, any>(),
        };
        sheets.set(row.school_expense_id, sheet);
      }
      const key = row.school_teacher_id ? `t${row.school_teacher_id}` : 'none';
      let teacher = sheet.teacherMap.get(key);
      if (!teacher) {
        teacher = {
          teacherId: row.school_teacher_id,
          name: row.teacher_name ?? null,
          bankAccount: row.bank_account,
          bankName: row.bank_name,
          taxCode: row.tax_code,
          classes: [] as string[],
          activities: [] as any[],
          gross: 0,
          tax: 0,
          net: 0,
          paidNet: 0,
        };
        sheet.teacherMap.set(key, teacher);
      }
      const className = (row.revenue_content ?? row.content ?? '').trim();
      if (className && !teacher.classes.includes(className)) teacher.classes.push(className);
      const paid = !!row.expense_date && !!row.cash_account;
      const activity = {
        itemId: row.id,
        subjectId: row.subject_id,
        subjectName: row.subject_name,
        rowIndex: row.row_index,
        className: className || null,
        totalPeriods: money(row.total_periods),
        studentCount: money(row.student_count),
        monthsCount: money(row.months_count),
        unitPrice: money(row.unit_price),
        amount: money(row.amount),
        pitRate: money(row.pit_rate),
        pitAmount: money(row.pit_amount),
        netAmount: money(row.net_amount),
        expenseDate: row.expense_date,
        cashAccount: row.cash_account,
        paid,
      };
      teacher.activities.push(activity);
      teacher.gross += activity.amount;
      teacher.tax += activity.pitAmount;
      teacher.net += activity.netAmount;
      if (paid) teacher.paidNet += activity.netAmount;
    }

    const sum = (items: any[], key: string) =>
      items.reduce((total, item) => total + Number(item[key] || 0), 0);
    const result = [...sheets.values()].map(({ teacherMap, ...sheet }) => {
      const teachers = [...teacherMap.values()];
      return {
        ...sheet,
        teachers,
        totals: {
          teacherCount: teachers.filter((t) => t.teacherId).length,
          unassignedRows: teachers.find((t) => !t.teacherId)?.activities.length ?? 0,
          gross: sum(teachers, 'gross'),
          tax: sum(teachers, 'tax'),
          net: sum(teachers, 'net'),
          paidNet: sum(teachers, 'paidNet'),
        },
      };
    });
    return {
      filters: { year, month, schoolId, schoolExpenseId },
      sheets: result,
      totals: {
        sheetCount: result.length,
        teacherCount: sum(result.map((r) => r.totals), 'teacherCount'),
        gross: sum(result.map((r) => r.totals), 'gross'),
        tax: sum(result.map((r) => r.totals), 'tax'),
        net: sum(result.map((r) => r.totals), 'net'),
        paidNet: sum(result.map((r) => r.totals), 'paidNet'),
      },
    };
  }
}
