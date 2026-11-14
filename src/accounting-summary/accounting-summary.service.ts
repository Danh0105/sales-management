import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryCashflowSummaryDto } from './dto/query-cashflow-summary.dto';

interface CashflowRow {
  schoolExpenseId: number | string;
  schoolId: number | string;
  schoolName: string;
  periodId: number | string;
  periodName: string | null;
  month: number | string;
  year: number | string;
  finalized: boolean;
  expectedRevenue: number | string;
  collectedRevenue: number | string;
  receivable: number | string;
  schoolExpense: number | string;
  schoolExpensePaid: number | string;
  schoolExpensePayable: number | string;
  managementExpense: number | string;
  managementExpensePaid: number | string;
  managementExpensePayable: number | string;
  cashPolicy: number | string;
  invoiceTotal?: number | string;
  invoiceIssued?: number | string;
  invoiceNone?: number | string;
}

interface SubjectCashflowRow {
  schoolExpenseId: number | string;
  subjectId: number | string;
  subjectName: string;
  expectedRevenue: number | string;
  collectedRevenue: number | string;
  receivable: number | string;
  schoolExpense: number | string;
  schoolExpensePaid: number | string;
  schoolExpensePayable: number | string;
  managementExpense: number | string;
  managementExpensePaid: number | string;
  managementExpensePayable: number | string;
  invoiceTotal: number | string;
  invoiceIssued: number | string;
  invoiceNone: number | string;
}

const money = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
};

const sumMoney = (values: number[]): number =>
  Math.round(values.reduce((sum, value) => sum + Math.round(value * 100), 0)) /
  100;

@Injectable()
export class AccountingSummaryService {
  constructor(private readonly dataSource: DataSource) {}

  async getCashflowSummary(query: QueryCashflowSummaryDto) {
    const parameters: Array<number | boolean> = [];
    const schoolExpenseFilters: string[] = [];

    const addFilter = (sql: string, value: number | boolean) => {
      parameters.push(value);
      schoolExpenseFilters.push(sql.replace('?', `$${parameters.length}`));
    };

    if (query.year !== undefined) addFilter('ep."year" = ?', query.year);
    if (query.month !== undefined) addFilter('ep."month" = ?', query.month);
    if (query.schoolId !== undefined) addFilter('s.id = ?', query.schoolId);
    if (query.finalized !== undefined) {
      addFilter('se.finalized = ?', query.finalized);
    }

    let subjectFilter = '';
    if (query.subjectId !== undefined) {
      parameters.push(query.subjectId);
      subjectFilter = `WHERE "subject_id" = $${parameters.length}`;
      schoolExpenseFilters.push(
        `EXISTS (
          SELECT 1
          FROM subjects subject_filter
          WHERE subject_filter.id = $${parameters.length}
            AND subject_filter.school_id = s.id
        )`,
      );
    }

    const where = schoolExpenseFilters.length
      ? `WHERE ${schoolExpenseFilters.join(' AND ')}`
      : '';
    const subjectWhere = [
      ...schoolExpenseFilters,
      ...(query.subjectId !== undefined
        ? [`subject_row.id = $${parameters.length}`]
        : []),
    ];
    const subjectRowsWhere = subjectWhere.length
      ? `WHERE ${subjectWhere.join(' AND ')}`
      : '';

    // Mỗi bảng được gom riêng trước khi JOIN để không nhân chéo các dòng thu/chi.
    const rows = await this.dataSource.query<CashflowRow[]>(
      `
      WITH revenue AS (
        SELECT
          "school_expense_id",
          COALESCE(SUM("invoiceAmount"), 0) AS "expectedRevenue",
          COALESCE(SUM("paidAmount"), 0) AS "collectedRevenue",
          COALESCE(SUM("remainingAmount"), 0) AS "receivable"
        FROM revenue_items
        ${subjectFilter}
        GROUP BY "school_expense_id"
      ),
      -- Chi Trường + Giáo viên trường (tách khỏi Chi Trường từ kỳ 11/2026): lương
      -- giáo viên đủ Ngày chi + Nguồn chi tính là đã trả cả Thành tiền.
      school_cost AS (
        SELECT
          "school_expense_id",
          COALESCE(SUM(expected), 0) AS "schoolExpense",
          COALESCE(SUM(paid), 0) AS "schoolExpensePaid",
          COALESCE(SUM(payable), 0) AS "schoolExpensePayable"
        FROM (
          SELECT "school_expense_id", "subject_id",
            "schoolExpenseAmount" AS expected, "paidAmount" AS paid, remaining AS payable
          FROM school_expense_items
          UNION ALL
          SELECT school_expense_id AS "school_expense_id", subject_id AS "subject_id",
            amount AS expected,
            CASE WHEN expense_date IS NOT NULL AND cash_account IS NOT NULL THEN amount ELSE 0 END AS paid,
            CASE WHEN expense_date IS NOT NULL AND cash_account IS NOT NULL THEN 0 ELSE amount END AS payable
          FROM school_teacher_expense_items
        ) school_rows
        ${subjectFilter}
        GROUP BY "school_expense_id"
      ),
      management_cost AS (
        SELECT
          "school_expense_id",
          COALESCE(SUM("totalOutside"), 0) AS "managementExpense",
          COALESCE(SUM("paidAmount"), 0) AS "managementExpensePaid",
          COALESCE(SUM(remaining), 0) AS "managementExpensePayable"
        FROM management_expense_items
        ${subjectFilter}
        GROUP BY "school_expense_id"
      ),
      -- Bảng Hóa Đơn: Thành tiền = Tổng thanh toán công ty của dòng = Số lượng
      -- × (Đơn giá − GV − Thuế − CSVC của dòng Chi Trường cùng vị trí; "Không có
      -- trong HĐ" giữ nguyên Đơn giá) — cùng công thức bảng Hóa Đơn ở kido-app.
      -- Đã xuất = dòng đã khoá "Xuất hóa đơn" hoặc có số HĐ; dòng "Không xuất
      -- HĐ" tính riêng.
      invoice AS (
        SELECT
          r."school_expense_id",
          COALESCE(SUM(a.amount), 0) AS "invoiceTotal",
          COALESCE(SUM(a.amount) FILTER (
            WHERE COALESCE(r."invoiceType", '') <> 'none'
              AND (r."invoiceLocked" OR NULLIF(btrim(r."invoiceNumber"), '') IS NOT NULL)
          ), 0) AS "invoiceIssued",
          COALESCE(SUM(a.amount) FILTER (
            WHERE r."invoiceType" = 'none'
          ), 0) AS "invoiceNone"
        FROM revenue_items r
        LEFT JOIN LATERAL (
          SELECT sei.teacher_unit_price, sei.tax_unit_price, sei.csvc, sei.payment_type
          FROM school_expense_items sei
          WHERE sei.school_expense_id = r.school_expense_id
            AND sei.subject_id = r.subject_id
            AND sei."rowIndex" = r."rowIndex"
          ORDER BY sei.id
          LIMIT 1
        ) s ON true
        CROSS JOIN LATERAL (
          SELECT
            (CASE WHEN COALESCE(r."studentCount", 0) > 0 THEN r."studentCount"
                  ELSE COALESCE(r."totalPeriods", 0) END)
            * COALESCE(r."monthsCount", 1)
            * (CASE WHEN s.payment_type = 'not_in_contract' THEN COALESCE(r."unitPrice", 0)
                    ELSE COALESCE(r."unitPrice", 0)
                      - (COALESCE(s.teacher_unit_price, 0) + COALESCE(s.tax_unit_price, 0) + COALESCE(s.csvc, 0))
               END) AS amount
        ) a
        ${subjectFilter.replace('"subject_id"', 'r."subject_id"')}
        GROUP BY r."school_expense_id"
      ),
      cash_policy AS (
        SELECT
          "school_expense_id",
          COALESCE(SUM("cashPolicyAmount" + "otherAmount"), 0) AS "cashPolicy"
        FROM cash_policy_items
        GROUP BY "school_expense_id"
      )
      SELECT
        se.id AS "schoolExpenseId",
        s.id AS "schoolId",
        s.name AS "schoolName",
        ep.id AS "periodId",
        ep.name AS "periodName",
        ep.month,
        ep.year,
        se.finalized,
        COALESCE(r."expectedRevenue", 0) AS "expectedRevenue",
        COALESCE(r."collectedRevenue", 0) AS "collectedRevenue",
        COALESCE(r.receivable, 0) AS receivable,
        COALESCE(sc."schoolExpense", 0) AS "schoolExpense",
        COALESCE(sc."schoolExpensePaid", 0) AS "schoolExpensePaid",
        COALESCE(sc."schoolExpensePayable", 0) AS "schoolExpensePayable",
        COALESCE(mc."managementExpense", 0) AS "managementExpense",
        COALESCE(mc."managementExpensePaid", 0) AS "managementExpensePaid",
        COALESCE(mc."managementExpensePayable", 0) AS "managementExpensePayable",
        COALESCE(cp."cashPolicy", 0) AS "cashPolicy",
        COALESCE(inv."invoiceTotal", 0) AS "invoiceTotal",
        COALESCE(inv."invoiceIssued", 0) AS "invoiceIssued",
        COALESCE(inv."invoiceNone", 0) AS "invoiceNone"
      FROM school_expenses se
      INNER JOIN schools s ON s.id = se.school_id
      INNER JOIN expense_periods ep ON ep.id = se.period_id
      LEFT JOIN revenue r ON r."school_expense_id" = se.id
      LEFT JOIN school_cost sc ON sc."school_expense_id" = se.id
      LEFT JOIN management_cost mc ON mc."school_expense_id" = se.id
      LEFT JOIN cash_policy cp ON cp."school_expense_id" = se.id
      LEFT JOIN invoice inv ON inv."school_expense_id" = se.id
      ${where}
      ORDER BY ep.year DESC, ep.month DESC, s.name ASC, se.id ASC
      `,
      parameters,
    );

    // Breakdown theo môn dùng đúng các bảng nguồn có subject_id. Chính sách
    // tiền mặt không có môn nên vẫn nằm ở cấp phiếu; frontend sẽ đưa phần chênh
    // đó vào dòng "Khoản chung / chưa phân môn", không tự phân bổ.
    const subjectRows = await this.dataSource.query<SubjectCashflowRow[]>(
      `
      WITH revenue AS (
        SELECT
          "school_expense_id",
          "subject_id",
          COALESCE(SUM("invoiceAmount"), 0) AS "expectedRevenue",
          COALESCE(SUM("paidAmount"), 0) AS "collectedRevenue",
          COALESCE(SUM("remainingAmount"), 0) AS receivable
        FROM revenue_items
        GROUP BY "school_expense_id", "subject_id"
      ),
      school_cost AS (
        SELECT
          "school_expense_id",
          "subject_id",
          COALESCE(SUM(expected), 0) AS "schoolExpense",
          COALESCE(SUM(paid), 0) AS "schoolExpensePaid",
          COALESCE(SUM(payable), 0) AS "schoolExpensePayable"
        FROM (
          SELECT "school_expense_id", "subject_id",
            "schoolExpenseAmount" AS expected, "paidAmount" AS paid, remaining AS payable
          FROM school_expense_items
          UNION ALL
          SELECT school_expense_id AS "school_expense_id", subject_id AS "subject_id",
            amount AS expected,
            CASE WHEN expense_date IS NOT NULL AND cash_account IS NOT NULL THEN amount ELSE 0 END AS paid,
            CASE WHEN expense_date IS NOT NULL AND cash_account IS NOT NULL THEN 0 ELSE amount END AS payable
          FROM school_teacher_expense_items
        ) school_rows
        GROUP BY "school_expense_id", "subject_id"
      ),
      management_cost AS (
        SELECT
          "school_expense_id",
          "subject_id",
          COALESCE(SUM("totalOutside"), 0) AS "managementExpense",
          COALESCE(SUM("paidAmount"), 0) AS "managementExpensePaid",
          COALESCE(SUM(remaining), 0) AS "managementExpensePayable"
        FROM management_expense_items
        GROUP BY "school_expense_id", "subject_id"
      ),
      invoice AS (
        SELECT
          r."school_expense_id",
          r."subject_id",
          COALESCE(SUM(a.amount), 0) AS "invoiceTotal",
          COALESCE(SUM(a.amount) FILTER (
            WHERE COALESCE(r."invoiceType", '') <> 'none'
              AND (r."invoiceLocked" OR NULLIF(btrim(r."invoiceNumber"), '') IS NOT NULL)
          ), 0) AS "invoiceIssued",
          COALESCE(SUM(a.amount) FILTER (
            WHERE r."invoiceType" = 'none'
          ), 0) AS "invoiceNone"
        FROM revenue_items r
        LEFT JOIN LATERAL (
          SELECT sei.teacher_unit_price, sei.tax_unit_price, sei.csvc, sei.payment_type
          FROM school_expense_items sei
          WHERE sei.school_expense_id = r.school_expense_id
            AND sei.subject_id = r.subject_id
            AND sei."rowIndex" = r."rowIndex"
          ORDER BY sei.id
          LIMIT 1
        ) s ON true
        CROSS JOIN LATERAL (
          SELECT
            (CASE WHEN COALESCE(r."studentCount", 0) > 0 THEN r."studentCount"
                  ELSE COALESCE(r."totalPeriods", 0) END)
            * COALESCE(r."monthsCount", 1)
            * (CASE WHEN s.payment_type = 'not_in_contract' THEN COALESCE(r."unitPrice", 0)
                    ELSE COALESCE(r."unitPrice", 0)
                      - (COALESCE(s.teacher_unit_price, 0) + COALESCE(s.tax_unit_price, 0) + COALESCE(s.csvc, 0))
               END) AS amount
        ) a
        GROUP BY r."school_expense_id", r."subject_id"
      )
      SELECT
        se.id AS "schoolExpenseId",
        subject_row.id AS "subjectId",
        subject_row.name AS "subjectName",
        COALESCE(r."expectedRevenue", 0) AS "expectedRevenue",
        COALESCE(r."collectedRevenue", 0) AS "collectedRevenue",
        COALESCE(r.receivable, 0) AS receivable,
        COALESCE(sc."schoolExpense", 0) AS "schoolExpense",
        COALESCE(sc."schoolExpensePaid", 0) AS "schoolExpensePaid",
        COALESCE(sc."schoolExpensePayable", 0) AS "schoolExpensePayable",
        COALESCE(mc."managementExpense", 0) AS "managementExpense",
        COALESCE(mc."managementExpensePaid", 0) AS "managementExpensePaid",
        COALESCE(mc."managementExpensePayable", 0) AS "managementExpensePayable",
        COALESCE(inv."invoiceTotal", 0) AS "invoiceTotal",
        COALESCE(inv."invoiceIssued", 0) AS "invoiceIssued",
        COALESCE(inv."invoiceNone", 0) AS "invoiceNone"
      FROM school_expenses se
      INNER JOIN schools s ON s.id = se.school_id
      INNER JOIN expense_periods ep ON ep.id = se.period_id
      INNER JOIN subjects subject_row
        ON subject_row.school_id = s.id
       AND (
         subject_row.school_year IS NULL
         OR subject_row.school_year = CONCAT(
           CASE WHEN ep.month >= 8 THEN ep.year ELSE ep.year - 1 END,
           '-',
           CASE WHEN ep.month >= 8 THEN ep.year + 1 ELSE ep.year END
         )
       )
      LEFT JOIN revenue r
        ON r."school_expense_id" = se.id AND r."subject_id" = subject_row.id
      LEFT JOIN school_cost sc
        ON sc."school_expense_id" = se.id AND sc."subject_id" = subject_row.id
      LEFT JOIN management_cost mc
        ON mc."school_expense_id" = se.id AND mc."subject_id" = subject_row.id
      LEFT JOIN invoice inv
        ON inv."school_expense_id" = se.id AND inv."subject_id" = subject_row.id
      ${subjectRowsWhere}
      ORDER BY ep.year DESC, ep.month DESC, s.name ASC, subject_row.name ASC, subject_row.id ASC
      `,
      parameters,
    );

    const subjectsBySchoolExpense = new Map<number, SubjectCashflowRow[]>();
    subjectRows.forEach((row) => {
      const schoolExpenseId = Number(row.schoolExpenseId);
      subjectsBySchoolExpense.set(schoolExpenseId, [
        ...(subjectsBySchoolExpense.get(schoolExpenseId) ?? []),
        row,
      ]);
    });

    const items = rows.map((row) => {
      const expectedRevenue = money(row.expectedRevenue);
      const collectedRevenue = money(row.collectedRevenue);
      const receivable = money(row.receivable);
      const schoolExpense = money(row.schoolExpense);
      const schoolExpensePaid = money(row.schoolExpensePaid);
      const schoolExpensePayable = money(row.schoolExpensePayable);
      const managementExpense = money(row.managementExpense);
      const managementExpensePaid = money(row.managementExpensePaid);
      const managementExpensePayable = money(row.managementExpensePayable);
      const cashPolicy = money(row.cashPolicy);
      const invoiceTotal = money(row.invoiceTotal);
      const invoiceIssued = money(row.invoiceIssued);
      const invoiceNone = money(row.invoiceNone);
      const expectedExpense = sumMoney([schoolExpense, managementExpense]);
      const paidExpense = sumMoney([schoolExpensePaid, managementExpensePaid]);
      const payable = sumMoney([
        schoolExpensePayable,
        managementExpensePayable,
      ]);

      return {
        schoolExpenseId: Number(row.schoolExpenseId),
        school: {
          id: Number(row.schoolId),
          name: row.schoolName,
        },
        period: {
          id: Number(row.periodId),
          name: row.periodName,
          month: Number(row.month),
          year: Number(row.year),
        },
        finalized: Boolean(row.finalized),
        revenue: {
          expected: expectedRevenue,
          collected: collectedRevenue,
          receivable,
        },
        expense: {
          expected: expectedExpense,
          paid: paidExpense,
          payable,
          school: {
            expected: schoolExpense,
            paid: schoolExpensePaid,
            payable: schoolExpensePayable,
          },
          management: {
            expected: managementExpense,
            paid: managementExpensePaid,
            payable: managementExpensePayable,
          },
        },
        cashPolicy,
        subjects: (
          subjectsBySchoolExpense.get(Number(row.schoolExpenseId)) ?? []
        ).map((subjectRow) => {
          const subjectExpectedRevenue = money(subjectRow.expectedRevenue);
          const subjectCollectedRevenue = money(subjectRow.collectedRevenue);
          const subjectReceivable = money(subjectRow.receivable);
          const subjectSchoolExpense = money(subjectRow.schoolExpense);
          const subjectSchoolExpensePaid = money(subjectRow.schoolExpensePaid);
          const subjectSchoolExpensePayable = money(
            subjectRow.schoolExpensePayable,
          );
          const subjectManagementExpense = money(subjectRow.managementExpense);
          const subjectManagementExpensePaid = money(
            subjectRow.managementExpensePaid,
          );
          const subjectManagementExpensePayable = money(
            subjectRow.managementExpensePayable,
          );
          const subjectInvoiceTotal = money(subjectRow.invoiceTotal);
          const subjectInvoiceIssued = money(subjectRow.invoiceIssued);
          const subjectInvoiceNone = money(subjectRow.invoiceNone);

          return {
            subject: {
              id: Number(subjectRow.subjectId),
              name: subjectRow.subjectName,
            },
            revenue: {
              expected: subjectExpectedRevenue,
              collected: subjectCollectedRevenue,
              receivable: subjectReceivable,
            },
            expense: {
              expected: sumMoney([
                subjectSchoolExpense,
                subjectManagementExpense,
              ]),
              paid: sumMoney([
                subjectSchoolExpensePaid,
                subjectManagementExpensePaid,
              ]),
              payable: sumMoney([
                subjectSchoolExpensePayable,
                subjectManagementExpensePayable,
              ]),
              school: {
                expected: subjectSchoolExpense,
                paid: subjectSchoolExpensePaid,
                payable: subjectSchoolExpensePayable,
              },
              management: {
                expected: subjectManagementExpense,
                paid: subjectManagementExpensePaid,
                payable: subjectManagementExpensePayable,
              },
            },
            invoice: {
              total: subjectInvoiceTotal,
              issued: subjectInvoiceIssued,
              notIssued: money(
                subjectInvoiceTotal - subjectInvoiceIssued - subjectInvoiceNone,
              ),
              noInvoice: subjectInvoiceNone,
            },
          };
        }),
        // Tổng hợp bảng Hóa Đơn: Tổng tiền HĐ = Đã xuất + Chưa xuất + Không xuất HĐ.
        invoice: {
          total: invoiceTotal,
          issued: invoiceIssued,
          notIssued: money(invoiceTotal - invoiceIssued - invoiceNone),
          noInvoice: invoiceNone,
        },
        projectedBalance: money(expectedRevenue - expectedExpense),
        projectedBalanceAfterPolicy: money(
          expectedRevenue - expectedExpense - cashPolicy,
        ),
        cashBalance: money(collectedRevenue - paidExpense),
      };
    });

    const expectedRevenue = sumMoney(
      items.map((item) => item.revenue.expected),
    );
    const collectedRevenue = sumMoney(
      items.map((item) => item.revenue.collected),
    );
    const receivable = sumMoney(items.map((item) => item.revenue.receivable));
    const expectedExpense = sumMoney(
      items.map((item) => item.expense.expected),
    );
    const paidExpense = sumMoney(items.map((item) => item.expense.paid));
    const payable = sumMoney(items.map((item) => item.expense.payable));
    const cashPolicy = sumMoney(items.map((item) => item.cashPolicy));
    const invoiceTotal = sumMoney(items.map((item) => item.invoice.total));
    const invoiceIssued = sumMoney(items.map((item) => item.invoice.issued));
    const invoiceNotIssued = sumMoney(
      items.map((item) => item.invoice.notIssued),
    );
    const invoiceNone = sumMoney(items.map((item) => item.invoice.noInvoice));

    return {
      filters: {
        year: query.year ?? null,
        month: query.month ?? null,
        schoolId: query.schoolId ?? null,
        subjectId: query.subjectId ?? null,
        finalized: query.finalized ?? null,
      },
      totals: {
        expectedRevenue,
        collectedRevenue,
        receivable,
        expectedExpense,
        paidExpense,
        payable,
        cashPolicy,
        invoiceTotal,
        invoiceIssued,
        invoiceNotIssued,
        invoiceNone,
        projectedBalance: money(expectedRevenue - expectedExpense),
        projectedBalanceAfterPolicy: money(
          expectedRevenue - expectedExpense - cashPolicy,
        ),
        cashBalance: money(collectedRevenue - paidExpense),
      },
      count: items.length,
      items,
    };
  }
}
