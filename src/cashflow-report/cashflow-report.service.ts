import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthUser } from '../type/auth-user.type';
import { CashAccount } from './cash-account.entity';
import {
  buildCashflowWorkbook,
  cashflowFileName,
  ExcelLedger,
} from './cashflow-excel';
import { Cents, centsToString, toCents } from './cashflow-money';
import {
  AccountBalance,
  buildSummary,
  computeBalances,
  filterLedgerRows,
  ReportRange,
  selectLedgerAccounts,
  validateLines,
} from './cashflow-ledger';
import {
  ExpenseRow,
  flagSuspiciousAmounts,
  INVOICE_ROWS_SQL,
  InvoiceRow,
  MANAGEMENT_EXPENSE_ROWS_SQL,
  mapExpenseRows,
  mapInvoiceRows,
  mapSuggestEvents,
  SCHOOL_EXPENSE_ROWS_SQL,
  SUGGEST_EVENTS_SQL,
  SuggestEventRow,
} from './cashflow-sources';
import {
  CashAccountInfo,
  CashGroup,
  CollectedLedger,
  LedgerIssue,
  LedgerLine,
} from './cashflow.types';
import { CashflowQueryDto } from './dto/cashflow-query.dto';
import { UpdateCashAccountDto } from './dto/update-cash-account.dto';

export const CASH_GROUP_TITLES: Record<CashGroup, string> = {
  '111': 'Tiền mặt',
  '112': 'Tiền gửi ngân hàng',
};

const money = (value: Cents | null) =>
  value === null ? null : centsToString(value);

/** Dữ liệu đã tổng hợp cho một khoảng ngày — giao diện và Excel dùng chung. */
export interface CashflowDataset {
  range: ReportRange;
  accounts: CashAccountInfo[];
  balances: Map<string, AccountBalance>;
  lines: LedgerLine[];
  issues: LedgerIssue[];
}

function isValidDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function scopeGroups(accountType?: string): CashGroup[] {
  if (accountType === 'cash') return ['111'];
  if (accountType === 'bank') return ['112'];
  return ['111', '112'];
}

@Injectable()
export class CashflowReportService {
  constructor(
    @InjectRepository(CashAccount)
    private readonly accountRepository: Repository<CashAccount>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  normalizeRange(query: Pick<CashflowQueryDto, 'from' | 'to'>): ReportRange {
    if (!isValidDate(query.from) || !isValidDate(query.to)) {
      throw new BadRequestException('Ngày không hợp lệ');
    }
    if (query.from > query.to) {
      throw new BadRequestException('Từ ngày phải trước hoặc bằng Đến ngày');
    }
    return { from: query.from, to: query.to };
  }

  async loadAccounts(): Promise<CashAccountInfo[]> {
    const rows = await this.accountRepository.find({
      order: { groupCode: 'ASC', sortOrder: 'ASC', code: 'ASC' },
    });
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      groupCode: row.groupCode as CashGroup,
      sortOrder: row.sortOrder,
      isActive: row.isActive,
      openingBalance:
        row.openingBalance === null ? null : toCents(row.openingBalance),
      openingBalanceDate: row.openingBalanceDate,
    }));
  }

  /** Gom bút toán từ 4 nguồn (song song, mỗi nguồn 1 truy vấn — không N+1). */
  async collect(accounts: CashAccountInfo[]): Promise<CollectedLedger> {
    const [invoiceRows, schoolRows, managementRows, suggestEvents] =
      await Promise.all([
        this.dataSource.query<InvoiceRow[]>(INVOICE_ROWS_SQL),
        this.dataSource.query<ExpenseRow[]>(SCHOOL_EXPENSE_ROWS_SQL),
        this.dataSource.query<ExpenseRow[]>(MANAGEMENT_EXPENSE_ROWS_SQL),
        this.dataSource.query<SuggestEventRow[]>(SUGGEST_EVENTS_SQL),
      ]);

    const parts = [
      mapInvoiceRows(invoiceRows),
      mapExpenseRows(schoolRows, 'SCHOOL_EXPENSE'),
      mapExpenseRows(managementRows, 'MANAGEMENT_EXPENSE'),
      mapSuggestEvents(suggestEvents),
    ];

    return validateLines(
      flagSuspiciousAmounts({
        lines: parts.flatMap((part) => part.lines),
        issues: parts.flatMap((part) => part.issues),
      }),
      accounts,
    );
  }

  async buildDataset(query: CashflowQueryDto): Promise<CashflowDataset> {
    const range = this.normalizeRange(query);
    const accounts = await this.loadAccounts();
    const { lines, issues } = await this.collect(accounts);
    const balances = computeBalances(accounts, lines, range);
    return { range, accounts, balances, lines, issues };
  }

  scopeAccounts(dataset: CashflowDataset, query: CashflowQueryDto) {
    const groups = scopeGroups(query.accountType);
    return dataset.accounts.filter(
      (account) =>
        groups.includes(account.groupCode) &&
        (!query.accountCode || account.code === query.accountCode),
    );
  }

  async getSummary(query: CashflowQueryDto) {
    const dataset = await this.buildDataset(query);
    const scope = this.scopeAccounts(dataset, query);
    const summary = buildSummary(
      scope,
      dataset.balances,
      dataset.lines,
      dataset.range,
    );
    const excludeInternal = query.excludeInternal === true;

    return {
      range: dataset.range,
      excludeInternal,
      openingTotal: money(summary.openingTotal),
      closingTotal: money(summary.closingTotal),
      verifiedOpeningTotal: money(summary.verifiedOpeningTotal),
      verifiedClosingTotal: money(summary.verifiedClosingTotal),
      receipts: money(
        excludeInternal ? summary.externalReceipts : summary.receipts,
      ),
      payments: money(
        excludeInternal ? summary.externalPayments : summary.payments,
      ),
      voucherCount: summary.voucherCount,
      unverifiedAccounts: summary.unverifiedAccounts,
      issueCount: this.issuesInRange(dataset).filter(
        (item) => !item.warningOnly,
      ).length,
      warningCount: this.issuesInRange(dataset).filter(
        (item) => item.warningOnly,
      ).length,
    };
  }

  async getAccounts(query: CashflowQueryDto) {
    const dataset = await this.buildDataset(query);
    const groups = scopeGroups(query.accountType);

    return {
      range: dataset.range,
      groups: groups.map((groupCode) => {
        const accounts = dataset.accounts.filter(
          (account) => account.groupCode === groupCode,
        );
        const summary = buildSummary(
          accounts,
          dataset.balances,
          dataset.lines,
          dataset.range,
        );
        return {
          groupCode,
          name: CASH_GROUP_TITLES[groupCode],
          accounts: accounts.map((account) => {
            const balance = dataset.balances.get(account.code)!;
            return {
              code: account.code,
              name: account.name,
              groupCode: account.groupCode,
              sortOrder: account.sortOrder,
              isActive: account.isActive,
              anchorBalance: money(account.openingBalance),
              anchorDate: account.openingBalanceDate,
              opening: money(balance.opening),
              receipts: money(balance.receipts),
              payments: money(balance.payments),
              closing: money(balance.closing),
              lineCount: balance.lineCount,
            };
          }),
          subtotal: {
            opening: money(summary.openingTotal),
            receipts: money(summary.receipts),
            payments: money(summary.payments),
            closing: money(summary.closingTotal),
            unverifiedAccounts: summary.unverifiedAccounts,
          },
        };
      }),
    };
  }

  /** Sổ chi tiết một nhóm tài khoản (111 hoặc 112). */
  buildLedger(
    dataset: CashflowDataset,
    group: CashGroup,
    query: CashflowQueryDto,
  ) {
    const accounts = selectLedgerAccounts(
      dataset.accounts,
      group,
      dataset.balances,
      query.accountCode,
    );
    const codes = accounts.map((account) => account.code);
    const { rows, totals, totalRows } = filterLedgerRows(
      dataset.lines,
      codes,
      dataset.range,
      query.search,
    );
    return { accounts, rows, totals, totalRows };
  }

  async getLedger(group: CashGroup, query: CashflowQueryDto) {
    const dataset = await this.buildDataset(query);
    const { accounts, rows, totals, totalRows } = this.buildLedger(
      dataset,
      group,
      query,
    );
    const page = query.page ?? 1;
    const limit = query.limit ?? 100;
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    return {
      group,
      title: CASH_GROUP_TITLES[group],
      range: dataset.range,
      searchActive: !!query.search?.trim(),
      accounts: accounts.map((account) => {
        const balance = dataset.balances.get(account.code)!;
        const total = totals.get(account.code)!;
        return {
          code: account.code,
          name: account.name,
          isActive: account.isActive,
          opening: money(balance.opening),
          receipts: money(total.receipts),
          payments: money(total.payments),
          closing: money(balance.closing),
        };
      }),
      rows: pageRows.map((row) => ({
        key: row.key,
        postingDate: row.postingDate,
        documentDate: row.documentDate,
        documentNo: row.documentNo,
        invoiceNo: row.invoiceNo,
        description: row.description,
        accountCode: row.accountCode,
        receipt: money(row.receipt),
        payment: money(row.payment),
        partnerCode: row.partnerCode,
        partnerName: row.partnerName,
        isInternalTransfer: row.isInternalTransfer,
        source: row.source,
      })),
      page,
      limit,
      totalRows,
    };
  }

  /**
   * Excel 3 sheet theo file mẫu, từ CÙNG dữ liệu tổng hợp với giao diện; toàn
   * bộ kết quả theo bộ lọc, không theo trang. Nhóm ngoài phạm vi "Loại tài
   * khoản" vẫn có sheet (đủ 3 sheet) nhưng không có cột tài khoản.
   */
  async exportExcel(
    query: CashflowQueryDto,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const dataset = await this.buildDataset(query);
    const groups = scopeGroups(query.accountType);
    const ledgerFor = (group: CashGroup): ExcelLedger =>
      groups.includes(group)
        ? { group, ...this.buildLedger(dataset, group, query) }
        : { group, accounts: [], rows: [], totals: new Map() };

    const workbook = buildCashflowWorkbook({
      range: dataset.range,
      accounts: dataset.accounts,
      balances: dataset.balances,
      cash: ledgerFor('111'),
      bank: ledgerFor('112'),
      search: query.search,
    });

    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      fileName: cashflowFileName(dataset.range),
    };
  }

  issuesInRange(dataset: CashflowDataset): LedgerIssue[] {
    return dataset.issues.filter(
      (item) =>
        item.date === null ||
        (item.date >= dataset.range.from && item.date <= dataset.range.to),
    );
  }

  async getIssues(query: CashflowQueryDto) {
    const dataset = await this.buildDataset(query);
    const groups = scopeGroups(query.accountType);
    const byCode = new Map(
      dataset.accounts.map((account) => [account.code, account]),
    );
    const issues = this.issuesInRange(dataset).filter((item) => {
      if (query.accountCode) return item.accountCode === query.accountCode;
      const account = item.accountCode
        ? byCode.get(item.accountCode)
        : undefined;
      return !account || groups.includes(account.groupCode);
    });

    return {
      range: dataset.range,
      issues: issues
        .sort(
          (a, b) =>
            Number(a.warningOnly) - Number(b.warningOnly) ||
            (a.date ?? '').localeCompare(b.date ?? '') ||
            a.key.localeCompare(b.key),
        )
        .map((item) => ({ ...item, amount: money(item.amount) })),
    };
  }

  async updateAccount(code: string, dto: UpdateCashAccountDto, user: AuthUser) {
    const account = await this.accountRepository.findOne({ where: { code } });
    if (!account) {
      throw new NotFoundException('Không tìm thấy tài khoản');
    }

    const touchesOpening =
      dto.openingBalance !== undefined || dto.openingBalanceDate !== undefined;

    if (touchesOpening) {
      const balance =
        dto.openingBalance !== undefined
          ? dto.openingBalance
          : account.openingBalance;
      const date =
        dto.openingBalanceDate !== undefined
          ? dto.openingBalanceDate
          : account.openingBalanceDate;

      if ((balance === null) !== (date === null)) {
        throw new BadRequestException(
          'Số dư gốc và ngày đối chiếu phải nhập cùng nhau (hoặc cùng để trống)',
        );
      }
      if (date !== null && !isValidDate(date)) {
        throw new BadRequestException('Ngày đối chiếu không hợp lệ');
      }

      account.openingBalance =
        balance === null ? null : centsToString(toCents(balance));
      account.openingBalanceDate = date;
      account.openingBalanceUpdatedBy = user.id;
      account.openingBalanceUpdatedByName = user.name ?? null;
      account.openingBalanceUpdatedAt = new Date();
    }
    if (dto.isActive !== undefined) {
      account.isActive = dto.isActive;
    }
    if (dto.note !== undefined) {
      account.note = dto.note;
    }

    return this.accountRepository.save(account);
  }
}
