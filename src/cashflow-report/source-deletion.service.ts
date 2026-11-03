import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { promises as fs } from 'fs';
import { basename, resolve } from 'path';
import { DataSource, EntityManager, In } from 'typeorm';
import { FinancialRequest } from '../financial-request/entities/financial-request.entity';
import { FinancialLedgerService } from '../financial-request/financial-ledger.service';
import { formatVnd } from '../financial-request/financial-money';
import { writeAudit } from '../financial-request/financial-notify.service';
import {
  AuditAction,
  FinancialRequestType,
  REQUEST_TYPE_LABELS,
} from '../financial-request/financial-request.constants';
import { absolutePath } from '../financial-request/financial-storage';
import { contractCode } from '../other-cashflow/other-cashflow.constants';
import { AuthUser } from '../type/auth-user.type';
import { cashLockedThrough, lockedMessage } from './cash-day-closing.service';
import { CashflowReportService } from './cashflow-report.service';
import { LedgerSourceRef } from './cashflow.types';
import { manualDocumentNo } from './manual-entry-source';

/** Nguồn của một dòng trên sổ mà thủ quỹ / kế toán trưởng được xoá. */
export const DELETABLE_SOURCES = [
  'FINANCIAL_REQUEST',
  'EXPENSE_REQUEST',
  'OTHER_CASHFLOW',
  'INVOICE',
  'SCHOOL_EXPENSE',
  'MANAGEMENT_EXPENSE',
  'MANUAL_ENTRY',
] as const;
export type DeletableSource = (typeof DELETABLE_SOURCES)[number];

export interface DeletionPlan {
  type: DeletableSource;
  id: number;
  /** DELETE = xoá hẳn chứng từ gốc và dữ liệu liên quan; UNPOST = chỉ gỡ khoản thu chi khỏi sổ. */
  mode: 'DELETE' | 'UNPOST';
  title: string;
  /** Các khoản sẽ bị xoá / gỡ — hiện cho người xoá xác nhận và báo lại sau khi xoá. */
  items: string[];
  warnings: string[];
  /** Không rỗng = không xoá được. */
  blockers: string[];
}

type Actor = { id: number; name: string | null };

/** Tệp trên đĩa: kho riêng của phân hệ tài chính hoặc /uploads/suggest. */
type FileRef = { kind: 'storage' | 'suggest'; path: string };

interface Prepared {
  plan: DeletionPlan;
  apply: (manager: EntityManager, actor: Actor) => Promise<void>;
  files: FileRef[];
  /** id nguồn của các dòng sổ bị ảnh hưởng (mặc định chính id được xoá). */
  ledgerIds?: number[];
}

/** Trường id trong nguồn của dòng sổ, theo loại nguồn. */
const SOURCE_ID_FIELD: Record<DeletableSource, keyof LedgerSourceRef> = {
  FINANCIAL_REQUEST: 'requestId',
  EXPENSE_REQUEST: 'suggestId',
  OTHER_CASHFLOW: 'otherCashflowId',
  INVOICE: 'itemId',
  SCHOOL_EXPENSE: 'itemId',
  MANAGEMENT_EXPENSE: 'itemId',
  MANUAL_ENTRY: 'manualEntryId',
};

const IRREVERSIBLE = 'Xoá vĩnh viễn, không khôi phục được.';
const SUGGEST_UPLOAD = /^\/uploads\/suggest\/[^/]+$/;

const SHEET_TABLES = {
  INVOICE: { table: 'revenue_items', prefix: 'HD', label: 'Hóa Đơn' },
  SCHOOL_EXPENSE: {
    table: 'school_expense_items',
    prefix: 'CT',
    label: 'Chi Trường',
  },
  MANAGEMENT_EXPENSE: {
    table: 'management_expense_items',
    prefix: 'CN',
    label: 'Chi Ngoài',
  },
} as const;

const money = (value: string | number | null | undefined) =>
  `${formatVnd(Math.round(Number(value ?? 0)))} đ`;

const vnDate = (value: string | null) =>
  value ? value.split('-').reverse().join('/') : '—';

/**
 * Xoá một dòng trên Tổng hợp thu chi kèm dữ liệu gốc của nó:
 * - Đề nghị tài chính / Đề xuất chi / Thu Chi ngoài: xoá hẳn chứng từ gốc và
 *   mọi dữ liệu phụ thuộc (tạm ứng đã có phiếu hoàn ứng thì xoá cả phiếu đó).
 * - Hóa Đơn / Chi Trường / Chi Ngoài: chỉ gỡ khoản thu chi của dòng khỏi sổ,
 *   doanh thu, chi phí và hoá đơn của trường giữ nguyên.
 * - Bút toán nhập tay: xoá mềm như ở hộp sửa bút toán.
 * Xem trước (`plan`) và thực hiện (`execute`) dùng cùng một bước chuẩn bị;
 * khi thực hiện, các dòng bị khoá trong transaction rồi mới tính lại.
 */
@Injectable()
export class SourceDeletionService {
  private readonly logger = new Logger(SourceDeletionService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly ledger: FinancialLedgerService,
    private readonly report: CashflowReportService,
  ) {}

  async plan(type: string, id: number): Promise<DeletionPlan> {
    const source = this.assertType(type);
    return (await this.prepare(this.dataSource.manager, source, id, false))
      .plan;
  }

  async execute(type: string, id: number, user: AuthUser) {
    const source = this.assertType(type);
    const actor = { id: user.id, name: await this.actorName(user) };
    let files: FileRef[] = [];
    const plan = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL lock_timeout = '5s'`);
      const prepared = await this.prepare(manager, source, id, true);
      if (prepared.plan.blockers.length) {
        throw new BadRequestException(prepared.plan.blockers.join(' '));
      }
      await prepared.apply(manager, actor);
      files = prepared.files;
      return prepared.plan;
    });
    await this.removeFiles(files);
    this.logger.log(
      `${plan.mode} ${plan.type}#${plan.id} bởi ${actor.id}: ${plan.title}`,
    );
    return plan;
  }

  private assertType(type: string): DeletableSource {
    if (!(DELETABLE_SOURCES as readonly string[]).includes(type)) {
      throw new BadRequestException('Loại chứng từ này không xoá được ở sổ');
    }
    return type as DeletableSource;
  }

  private async prepare(
    manager: EntityManager,
    type: DeletableSource,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    let prepared: Prepared;
    switch (type) {
      case 'FINANCIAL_REQUEST':
        prepared = await this.prepareFinancial(manager, id, lock);
        break;
      case 'EXPENSE_REQUEST':
        prepared = await this.prepareSuggest(manager, id, lock);
        break;
      case 'OTHER_CASHFLOW':
        prepared = await this.prepareOtherCashflow(manager, id, lock);
        break;
      case 'MANUAL_ENTRY':
        prepared = await this.prepareManualEntry(manager, id, lock);
        break;
      default:
        prepared = await this.prepareSheetRow(manager, type, id, lock);
    }
    const blocker = await this.closedDayBlocker(
      manager,
      type,
      prepared.ledgerIds ?? [id],
    );
    if (blocker) prepared.plan.blockers.push(blocker);
    return prepared;
  }

  /** Nguồn có dòng sổ thuộc ngày đã chốt quỹ → không xoá / gỡ được. */
  private async closedDayBlocker(
    manager: EntityManager,
    type: DeletableSource,
    ids: number[],
  ): Promise<string | null> {
    const lockedThrough = await cashLockedThrough(manager);
    if (!lockedThrough) return null;
    const accounts = await this.report.loadAccounts();
    const { lines } = await this.report.collect(accounts);
    const field = SOURCE_ID_FIELD[type];
    const closed = lines
      .filter(
        (line) =>
          line.source.type === type &&
          ids.includes(line.source[field] as number) &&
          line.postingDate <= lockedThrough,
      )
      .map((line) => line.postingDate)
      .sort()[0];
    return closed ? lockedMessage(closed, lockedThrough) : null;
  }

  // ---------------------------------------------------------------------------
  // Đề nghị tài chính
  // ---------------------------------------------------------------------------

  private async prepareFinancial(
    manager: EntityManager,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    const repo = manager.getRepository(FinancialRequest);
    const root = lock
      ? await this.ledger.lockRequest(manager, id)
      : await repo.findOne({ where: { id } });
    if (!root || root.deletedAt) {
      throw new NotFoundException('Không tìm thấy đề nghị tài chính');
    }
    // Phân bổ chặn xoá tạm ứng → phiếu hoàn ứng đối trừ tạm ứng này bị xoá cùng.
    const settlementIds: number[] =
      root.type === FinancialRequestType.ADVANCE
        ? (
            await manager.query<{ id: number }[]>(
              `SELECT DISTINCT settlement_id AS id FROM financial_advance_allocations WHERE advance_id = $1`,
              [id],
            )
          ).map((row) => row.id)
        : [];
    const settlements = settlementIds.length
      ? await repo.find({
          where: { id: In(settlementIds) },
          order: { id: 'ASC' },
          ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
        })
      : [];
    const requests = [root, ...settlements];
    const ids = requests.map((r) => r.id);

    const [stats] = await manager.query<
      {
        paid: number;
        paid_sum: string;
        voided: number;
        refunds: number;
        refund_sum: string;
        deductions: number;
      }[]
    >(
      `SELECT
        (SELECT count(*)::int FROM financial_payments WHERE request_id = ANY($1) AND status = 'RECORDED') AS paid,
        (SELECT coalesce(sum(amount), 0)::text FROM financial_payments WHERE request_id = ANY($1) AND status = 'RECORDED') AS paid_sum,
        (SELECT count(*)::int FROM financial_payments WHERE request_id = ANY($1) AND status <> 'RECORDED')
          + (SELECT count(*)::int FROM financial_refunds WHERE request_id = ANY($1) AND status <> 'RECORDED') AS voided,
        (SELECT count(*)::int FROM financial_refunds WHERE request_id = ANY($1) AND status = 'RECORDED') AS refunds,
        (SELECT coalesce(sum(amount), 0)::text FROM financial_refunds WHERE request_id = ANY($1) AND status = 'RECORDED') AS refund_sum,
        (SELECT count(*)::int FROM financial_salary_advance_deductions WHERE request_id = ANY($1)) AS deductions`,
      [ids],
    );
    const attachments = await manager.query<{ path: string }[]>(
      `SELECT storage_path AS path FROM financial_request_attachments WHERE request_id = ANY($1)`,
      [ids],
    );
    // Tạm ứng khác được phiếu hoàn ứng bị xoá đối trừ: trả lại phần đối trừ.
    const otherAdvances = await manager.query<
      { code: string; amount: string }[]
    >(
      `SELECT r.code, a.amount::text AS amount
       FROM financial_advance_allocations a
       JOIN financial_requests r ON r.id = a.advance_id
       WHERE a.settlement_id = ANY($1) AND NOT (a.advance_id = ANY($1)) AND a.applied_at IS NOT NULL
       ORDER BY r.code`,
      [ids],
    );

    const describe = (r: FinancialRequest) =>
      `${REQUEST_TYPE_LABELS[r.type]} ${r.code} — "${r.title}" — ${r.requesterName} — ${money(r.totalAmount)}` +
      (r.deletedAt ? ' (bản nháp đã xoá)' : '');
    const items = [
      describe(root),
      ...settlements.map(
        (s) => `Phiếu hoàn ứng đối trừ tạm ứng này: ${describe(s)}`,
      ),
    ];
    if (stats.paid) {
      items.push(`${stats.paid} lần chi tiền (${money(stats.paid_sum)})`);
    }
    if (stats.refunds) {
      items.push(
        `${stats.refunds} lần thu hoàn trả (${money(stats.refund_sum)})`,
      );
    }
    if (stats.voided) items.push(`${stats.voided} phiếu chi/thu đã huỷ`);
    if (stats.deductions) {
      items.push(`${stats.deductions} kỳ khấu trừ lương`);
    }
    if (attachments.length) {
      items.push(`${attachments.length} tệp đính kèm`);
    }
    items.push('Dòng chi tiết, các bước duyệt và thông báo của phiếu');
    for (const advance of otherAdvances) {
      items.push(
        `Tạm ứng ${advance.code}: bỏ đối trừ ${money(advance.amount)} (phiếu hoàn ứng bị xoá)`,
      );
    }

    return {
      plan: {
        type: 'FINANCIAL_REQUEST',
        id,
        mode: 'DELETE',
        title: `Xoá đề nghị tài chính ${root.code}`,
        items,
        warnings: [
          IRREVERSIBLE,
          'Nhật ký kiểm toán của phiếu vẫn giữ lại, có ghi người xoá.',
        ],
        blockers: [],
      },
      files: attachments.map((a) => ({ kind: 'storage', path: a.path })),
      ledgerIds: ids,
      apply: async (m, actor) => {
        for (const request of requests) {
          if (
            request.type === FinancialRequestType.SETTLEMENT &&
            !request.deletedAt
          ) {
            await this.ledger.revertSettlement(m, request);
          }
        }
        for (const sql of [
          `DELETE FROM financial_request_attachments WHERE request_id = ANY($1)`,
          `DELETE FROM financial_salary_advance_deductions WHERE request_id = ANY($1)`,
          `DELETE FROM financial_payments WHERE request_id = ANY($1)`,
          `DELETE FROM financial_refunds WHERE request_id = ANY($1)`,
          `DELETE FROM financial_advance_allocations WHERE advance_id = ANY($1) OR settlement_id = ANY($1)`,
          `DELETE FROM financial_requests WHERE id = ANY($1)`,
          `DELETE FROM notification WHERE type = 'FINANCIAL_REQUEST' AND "entityId" = ANY($1)`,
        ]) {
          await m.query(sql, [ids]);
        }
        for (const request of requests) {
          await writeAudit(m, {
            requestId: request.id,
            action: AuditAction.DELETED,
            fromStatus: request.approvalStatus,
            actorId: actor.id,
            actorName: actor.name,
            comment:
              request.id === id
                ? 'Xoá hẳn từ Tổng hợp thu chi'
                : `Xoá hẳn từ Tổng hợp thu chi cùng tạm ứng ${root.code}`,
            changes: {
              code: request.code,
              type: request.type,
              title: request.title,
              totalAmount: request.totalAmount,
              paidAmount: request.paidAmount,
              recoveredAmount: request.recoveredAmount,
            },
          });
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Đề xuất chi
  // ---------------------------------------------------------------------------

  private async prepareSuggest(
    manager: EntityManager,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    const [suggest] = await manager.query<
      {
        code: string | null;
        content: string;
        amount: string | null;
        file_url: string | null;
        creator: string | null;
      }[]
    >(
      `SELECT s.code, s.content, s.amount::text AS amount, s."fileUrl" AS file_url, e.name AS creator
       FROM suggest s LEFT JOIN employee e ON e.id = s."createdBy"
       WHERE s.id = $1 ${lock ? 'FOR UPDATE OF s' : ''}`,
      [id],
    );
    if (!suggest) throw new NotFoundException('Không tìm thấy đề xuất chi');
    const [stats] = await manager.query<
      {
        history: number;
        cash_events: number;
        stock_orders: number;
        receipts: number;
      }[]
    >(
      `SELECT
        (SELECT count(*)::int FROM suggest_history WHERE "suggestId" = $1) AS history,
        (SELECT count(*)::int FROM suggest_history WHERE "suggestId" = $1
           AND action::text IN ('CONFIRM_CASH_RELEASED', 'CONFIRM_FUND_RETURNED')) AS cash_events,
        (SELECT count(*)::int FROM suggest_stock_issue_order WHERE "suggestId" = $1)
          + (SELECT count(*)::int FROM suggest_stock_in_order WHERE "suggestId" = $1) AS stock_orders,
        (SELECT count(*)::int FROM warehouse_receipt WHERE "relatedSuggestId" = $1) AS receipts`,
      [id],
    );
    const orders = await manager.query<{ code: string; amount: string }[]>(
      `SELECT code, amount::text AS amount FROM suggest_payment_order WHERE "suggestId" = $1 ORDER BY id`,
      [id],
    );
    const attachments = await manager.query<{ url: string }[]>(
      `SELECT "fileUrl" AS url FROM suggest_attachment WHERE "suggestId" = $1`,
      [id],
    );
    const code = suggest.code ?? `#${id}`;
    const items = [
      `Đề xuất chi ${code} — "${suggest.content}"${suggest.creator ? ` — ${suggest.creator}` : ''}${suggest.amount ? ` — ${money(suggest.amount)}` : ''}`,
      ...orders.map((o) => `Lệnh chi ${o.code} (${money(o.amount)})`),
    ];
    if (stats.cash_events) {
      items.push(`${stats.cash_events} lần xuất tiền / nhận lại quỹ`);
    }
    items.push(`${stats.history} dòng lịch sử xử lý và thông báo của đề xuất`);
    const files = [suggest.file_url, ...attachments.map((a) => a.url)].filter(
      (url): url is string => !!url,
    );
    if (files.length) items.push(`${files.length} tệp đính kèm`);

    const blockers =
      stats.stock_orders || stats.receipts
        ? [
            'Đề xuất có phiếu xuất/nhập kho — xoá ở đây sẽ làm lệch tồn kho, không xoá được.',
          ]
        : [];
    return {
      plan: {
        type: 'EXPENSE_REQUEST',
        id,
        mode: 'DELETE',
        title: `Xoá đề xuất chi ${code}`,
        items,
        warnings: [IRREVERSIBLE],
        blockers,
      },
      files: files
        .filter((url) => SUGGEST_UPLOAD.test(url))
        .map((url) => ({ kind: 'suggest', path: url })),
      apply: async (m) => {
        await m.query(`DELETE FROM suggest_history WHERE "suggestId" = $1`, [
          id,
        ]);
        await m.query(
          `DELETE FROM notification WHERE type = 'SUGGEST' AND "entityId" = $1`,
          [id],
        );
        // Lệnh chi, tệp đính kèm, phân công: khoá ngoại CASCADE.
        await m.query(`DELETE FROM suggest WHERE id = $1`, [id]);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Thu Chi ngoài
  // ---------------------------------------------------------------------------

  private async prepareOtherCashflow(
    manager: EntityManager,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    const [contract] = await manager.query<
      {
        title: string;
        partner_name: string;
        amount: string;
        cost_amount: string;
      }[]
    >(
      `SELECT title, partner_name, amount::text AS amount, cost_amount::text AS cost_amount
       FROM other_cashflow_contracts WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!contract)
      throw new NotFoundException('Không tìm thấy hợp đồng Thu Chi ngoài');
    const [stats] = await manager.query<
      {
        entries: number;
        entry_sum: string;
        voided: number;
        orders: number;
        items: number;
        costs: number;
      }[]
    >(
      `SELECT
        (SELECT count(*)::int FROM other_cashflow_entries WHERE contract_id = $1 AND status = 'RECORDED') AS entries,
        (SELECT coalesce(sum(amount), 0)::text FROM other_cashflow_entries WHERE contract_id = $1 AND status = 'RECORDED') AS entry_sum,
        (SELECT count(*)::int FROM other_cashflow_entries WHERE contract_id = $1 AND status <> 'RECORDED') AS voided,
        (SELECT count(*)::int FROM other_cashflow_orders WHERE contract_id = $1) AS orders,
        (SELECT count(*)::int FROM other_cashflow_items WHERE contract_id = $1) AS items,
        (SELECT count(*)::int FROM other_cashflow_costs WHERE contract_id = $1) AS costs`,
      [id],
    );
    const attachments = await manager.query<{ path: string }[]>(
      `SELECT storage_path AS path FROM other_cashflow_attachments WHERE contract_id = $1`,
      [id],
    );
    const code = contractCode(id);
    const items = [
      `Hợp đồng Thu Chi ngoài ${code} — "${contract.title}" — ${contract.partner_name} — thu ${money(contract.amount)} · chi ${money(contract.cost_amount)}`,
    ];
    if (stats.items) items.push(`${stats.items} khoản thu`);
    if (stats.entries) {
      items.push(`${stats.entries} lần thu/chi (${money(stats.entry_sum)})`);
    }
    if (stats.voided) items.push(`${stats.voided} lần thu/chi đã huỷ`);
    if (stats.orders) items.push(`${stats.orders} phiếu thu / lệnh chi`);
    if (stats.costs) items.push(`${stats.costs} khoản chi`);
    if (attachments.length) items.push(`${attachments.length} tệp đính kèm`);
    items.push('Lịch sử xử lý và thông báo của hợp đồng');

    return {
      plan: {
        type: 'OTHER_CASHFLOW',
        id,
        mode: 'DELETE',
        title: `Xoá hợp đồng Thu Chi ngoài ${code}`,
        items,
        warnings: [IRREVERSIBLE],
        blockers: [],
      },
      files: attachments.map((a) => ({ kind: 'storage', path: a.path })),
      apply: async (m) => {
        // Thứ tự theo khoá ngoại RESTRICT: tệp → lần thu/chi → phiếu → chi phí.
        for (const table of [
          'other_cashflow_attachments',
          'other_cashflow_entries',
          'other_cashflow_orders',
          'other_cashflow_costs',
          'other_cashflow_events',
          'other_cashflow_items',
        ]) {
          await m.query(`DELETE FROM ${table} WHERE contract_id = $1`, [id]);
        }
        await m.query(
          `DELETE FROM notification WHERE meta->>'kind' = 'other_cashflow' AND meta->>'contractId' = $1`,
          [String(id)],
        );
        await m.query(`DELETE FROM other_cashflow_contracts WHERE id = $1`, [
          id,
        ]);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Hóa Đơn / Chi Trường / Chi Ngoài — chỉ gỡ khỏi sổ
  // ---------------------------------------------------------------------------

  private async prepareSheetRow(
    manager: EntityManager,
    type: keyof typeof SHEET_TABLES,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    const { table, prefix, label } = SHEET_TABLES[type];
    const isInvoice = type === 'INVOICE';
    const posting = isInvoice
      ? `to_char(t."invoicePaymentDate", 'YYYY-MM-DD') AS cash_date,
         t."invoiceCashAccount" AS cash_account,
         t."invoiceCashDirection" AS cash_direction,
         t."invoiceCashAmount"::text AS cash_amount`
      : `to_char(t."expenseDate", 'YYYY-MM-DD') AS cash_date,
         t."cashAccount" AS cash_account,
         'OUT' AS cash_direction,
         t."paidAmount"::text AS cash_amount`;
    const [row] = await manager.query<
      {
        school_expense_id: number;
        subject_id: number | null;
        row_index: number;
        school_name: string | null;
        subject_name: string | null;
        month: number | null;
        year: number | null;
        cash_date: string | null;
        cash_account: string | null;
        cash_direction: string | null;
        cash_amount: string | null;
      }[]
    >(
      `SELECT t.school_expense_id, t.subject_id, t."rowIndex" AS row_index,
         s.name AS school_name, sub.name AS subject_name, ep.month, ep.year,
         ${posting}
       FROM ${table} t
       JOIN school_expenses se ON se.id = t.school_expense_id
       LEFT JOIN schools s ON s.id = se.school_id
       LEFT JOIN subjects sub ON sub.id = t.subject_id
       LEFT JOIN expense_periods ep ON ep.id = se.period_id
       WHERE t.id = $1 ${lock ? 'FOR UPDATE OF t' : ''}`,
      [id],
    );
    if (!row) throw new NotFoundException(`Không tìm thấy dòng ${label}`);

    const documentNo = `${prefix}-${row.school_expense_id}-${row.subject_id ?? 0}-${row.row_index + 1}`;
    const where = [
      row.school_name,
      row.subject_name,
      row.month && row.year ? `tháng ${row.month}/${row.year}` : null,
    ]
      .filter(Boolean)
      .join(' — ');
    const amount = Number(row.cash_amount ?? 0);
    const posted = isInvoice
      ? row.cash_direction !== null ||
        row.cash_amount !== null ||
        row.cash_account !== null ||
        row.cash_date !== null
      : amount > 0 || row.cash_account !== null || row.cash_date !== null;
    const direction =
      row.cash_direction === 'IN'
        ? 'Thu'
        : row.cash_direction === 'OUT'
          ? 'Chi'
          : 'Thu/Chi chưa chọn';

    return {
      plan: {
        type,
        id,
        mode: 'UNPOST',
        title: `Gỡ dòng ${label} ${documentNo} khỏi sổ`,
        items: [
          `${label} ${documentNo}${where ? ` — ${where}` : ''}`,
          `Bỏ khoản ${direction.toLowerCase()} ${money(amount)} · tài khoản ${row.cash_account ?? '—'} · ngày ${vnDate(row.cash_date)}`,
        ],
        warnings: [
          isInvoice
            ? 'Chỉ xoá Thu/Chi, Số tiền thu/chi, Ngày chi, Khoản thu/chi của dòng; doanh thu, Đã thu và hoá đơn giữ nguyên.'
            : '"Đã chi" của dòng về 0 ("Còn lại" tăng tương ứng), xoá Ngày chi và Nguồn chi; chi phí của trường giữ nguyên.',
          'Muốn ghi lại vào sổ thì nhập lại ở màn QL thu chi.',
        ],
        blockers: posted
          ? []
          : ['Dòng này không còn khoản thu chi nào trên sổ.'],
      },
      files: [],
      apply: async (m) => {
        await m.query(
          isInvoice
            ? `UPDATE revenue_items SET "invoicePaymentDate" = NULL, "invoiceCashAccount" = NULL,
                 "invoiceCashDirection" = NULL, "invoiceCashAmount" = NULL WHERE id = $1`
            : `UPDATE ${table} SET "remaining" = "remaining" + "paidAmount", "paidAmount" = 0,
                 "expenseDate" = NULL, "cashAccount" = NULL WHERE id = $1`,
          [id],
        );
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Bút toán nhập tay — xoá mềm
  // ---------------------------------------------------------------------------

  private async prepareManualEntry(
    manager: EntityManager,
    id: number,
    lock: boolean,
  ): Promise<Prepared> {
    const [entry] = await manager.query<
      {
        kind: 'IN' | 'OUT' | 'TRANSFER';
        document_no: string | null;
        description: string;
        amount: string;
        entry_date: string;
      }[]
    >(
      `SELECT kind, document_no, description, amount::text AS amount, to_char(entry_date, 'YYYY-MM-DD') AS entry_date
       FROM cash_manual_entries WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!entry) throw new NotFoundException('Không tìm thấy bút toán');
    const documentNo = manualDocumentNo({ id, ...entry });
    return {
      plan: {
        type: 'MANUAL_ENTRY',
        id,
        mode: 'DELETE',
        title: `Xoá bút toán ${documentNo}`,
        items: [
          `Bút toán nhập tay ${documentNo} — "${entry.description}" — ${money(entry.amount)} — ngày ${vnDate(entry.entry_date)}`,
        ],
        warnings: ['Bút toán ra khỏi sổ; hệ thống vẫn lưu lại người xoá.'],
        blockers: [],
      },
      files: [],
      apply: async (m, actor) => {
        await m.query(
          `UPDATE cash_manual_entries SET deleted_at = now(), deleted_by = $2, deleted_by_name = $3 WHERE id = $1`,
          [id, actor.id, actor.name],
        );
      },
    };
  }

  // ---------------------------------------------------------------------------

  /** Xoá tệp sau khi commit; tệp còn dòng khác dùng (vd. phiếu sao chép) thì giữ. */
  private async removeFiles(files: FileRef[]) {
    for (const file of files) {
      try {
        if (file.kind === 'storage') {
          const [{ used }] = await this.dataSource.query<{ used: boolean }[]>(
            `SELECT EXISTS (SELECT 1 FROM financial_request_attachments WHERE storage_path = $1)
               OR EXISTS (SELECT 1 FROM other_cashflow_attachments WHERE storage_path = $1) AS used`,
            [file.path],
          );
          if (!used) await fs.unlink(absolutePath(file.path));
        } else {
          const [{ used }] = await this.dataSource.query<{ used: boolean }[]>(
            `SELECT EXISTS (SELECT 1 FROM suggest_attachment WHERE "fileUrl" = $1)
               OR EXISTS (SELECT 1 FROM suggest WHERE "fileUrl" = $1) AS used`,
            [file.path],
          );
          if (!used) {
            await fs.unlink(
              resolve(process.cwd(), 'uploads', 'suggest', basename(file.path)),
            );
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.logger.warn(
            `Không xoá được tệp ${file.path}: ${(error as Error).message}`,
          );
        }
      }
    }
  }

  /** Token có thể thiếu tên — lấy từ hồ sơ nhân viên. */
  private async actorName(user: AuthUser): Promise<string | null> {
    if (user.name) return user.name;
    const [row] = await this.dataSource.query<{ name: string }[]>(
      'SELECT name FROM employee WHERE id = $1',
      [user.id],
    );
    return row?.name ?? null;
  }
}
