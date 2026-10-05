import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { RevenueInvoiceType } from '../revenue-item/revenue-invoice-status.enum';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { School } from '../school/schools.entity';
import { Subject } from '../subject/subject.entity';
import { AuthUser } from '../type/auth-user.type';
import {
  buildDraftPayload,
  DEFAULT_INVOICE_UNIT,
  InvoiceItem,
  invoiceItemName,
  invoiceLine,
} from './revenue-einvoice.calculator';
import {
  RevenueEInvoice,
  RevenueEInvoiceStatus,
} from './revenue-einvoice.entity';
import {
  TRANSACTION_UUID_USED,
  ViettelDraftResult,
  ViettelIssuedInvoice,
  ViettelSinvoiceClient,
  ViettelSinvoiceError,
} from './viettel-sinvoice.client';
import {
  getViettelSinvoiceConfig,
  missingViettelSettings,
} from './viettel-sinvoice.config';
import type { ViettelInvoicePayload } from './viettel-invoice-payload';

export type InvoiceExportStatus = 'created' | 'unchanged' | 'changed' | 'error';

export interface InvoiceExportResult {
  /** Dòng doanh thu nằm trên hóa đơn. */
  rowIndexes: number[];
  amount: number | null;
  status: InvoiceExportStatus;
  message?: string;
}

export interface SkippedRow {
  rowIndex: number;
  itemName: string;
  message: string;
}

export interface ExportDraftsSummary {
  /** Hóa đơn nháp gộp các dòng chưa có hóa đơn — null khi không có dòng mới. */
  draft: InvoiceExportResult | null;
  /** Hóa đơn nháp đã tạo từ trước, so với dữ liệu hiện tại (unchanged/changed). */
  existing: InvoiceExportResult[];
  /** Dòng "Xuất HĐ Cty" không đưa vào hóa đơn. */
  skipped: SkippedRow[];
}

/**
 * API 7.8 không sửa được nháp đã tạo (gửi lại cùng transactionUuid bị từ chối),
 * còn tạo nháp mới thì sinh hóa đơn trùng cho cùng dòng.
 */
const DRAFT_CHANGED_MESSAGE =
  'Hóa đơn nháp đã tạo khác với dữ liệu hiện tại (số liệu dòng hoặc mẫu/ký hiệu) — Viettel không cho sửa nháp qua API, hãy sửa hóa đơn nháp trực tiếp trên portal Viettel';

interface ExportContext {
  /** MST tài khoản Viettel đang cấu hình — nơi tạo hóa đơn nháp. */
  supplierTaxCode: string;
  schoolExpenseId: number;
  subjectId: number;
  subjectName: string;
  school: School;
  templateCode: string;
  invoiceSeries: string;
  user: AuthUser;
}

/** Dòng doanh thu "Xuất HĐ Cty" kèm dòng Chi Trường cùng index (nếu đã lưu). */
type CompanyRow = { revenue: RevenueItem; schoolRow?: SchoolExpenseItem };

/**
 * Dòng hàng của hóa đơn. Hóa đơn tạo theo cách cũ (mỗi dòng 1 hóa đơn) chưa
 * có `lines` — dựng lại từ row_index và itemInfo đã gửi.
 */
function linesOf(record: RevenueEInvoice): InvoiceItem[] {
  if (record.lines?.length) return record.lines;
  if (record.legacyRowIndex == null) return [];
  const item = (record.rawRequest as ViettelInvoicePayload | null)
    ?.itemInfo?.[0];
  return [
    {
      rowIndex: record.legacyRowIndex,
      itemName: item?.itemName ?? '',
      unitName: item?.unitName ?? '',
      quantity: item?.quantity ?? 0,
      unitPrice: item?.unitPrice ?? 0,
      amount: Number(record.amount),
    },
  ];
}

const rowNumbers = (rowIndexes: number[]) =>
  rowIndexes.map((i) => i + 1).join(', ');

@Injectable()
export class RevenueEInvoicesService {
  private readonly logger = new Logger(RevenueEInvoicesService.name);

  constructor(
    @InjectRepository(RevenueEInvoice)
    private readonly einvoices: Repository<RevenueEInvoice>,
    @InjectRepository(SchoolExpense)
    private readonly schoolExpenses: Repository<SchoolExpense>,
    @InjectRepository(Subject)
    private readonly subjects: Repository<Subject>,
    @InjectRepository(RevenueItem)
    private readonly revenueItems: Repository<RevenueItem>,
    @InjectRepository(SchoolExpenseItem)
    private readonly schoolItems: Repository<SchoolExpenseItem>,
    private readonly viettel: ViettelSinvoiceClient,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Hóa đơn của môn thuộc tài khoản Viettel đang cấu hình: các nháp đã tạo và
   * lần đẩy gần nhất chưa thành công (nếu có).
   */
  async list(schoolExpenseId: number, subjectId: number) {
    const { supplierTaxCode } = getViettelSinvoiceConfig(this.configService);
    const subject = { schoolExpenseId, subjectId, supplierTaxCode };
    const records = await this.einvoices.find({
      where: [
        { ...subject, status: RevenueEInvoiceStatus.DraftCreated },
        // Lỗi của bản cũ (mỗi dòng 1 hóa đơn) không còn ý nghĩa: lần đẩy sau gộp lại.
        { ...subject, legacyRowIndex: IsNull() },
      ],
      order: { id: 'ASC' },
    });
    return records.map((record) => ({
      id: record.id,
      status: record.status,
      lines: linesOf(record),
      amount: record.amount,
      buyerName: record.buyerName,
      buyerTaxCode: record.buyerTaxCode,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
      draftedAt: record.draftedAt,
      exportedByName: record.exportedByName,
      updatedAt: record.updatedAt,
    }));
  }

  /**
   * "Đẩy hóa đơn": gộp mọi dòng doanh thu "Xuất HĐ Cty" của môn chưa có hóa
   * đơn thành 1 hóa đơn nháp trên Viettel, bên mua là trường. Dòng đã nằm
   * trong nháp trước đó thì không gửi lại, chỉ báo nếu số liệu đã đổi.
   */
  async exportDrafts(
    schoolExpenseId: number,
    subjectId: number,
    user: AuthUser,
  ): Promise<ExportDraftsSummary> {
    const config = getViettelSinvoiceConfig(this.configService);
    if (!config.enabled) {
      throw new BadRequestException(
        'Chưa bật hóa đơn điện tử Viettel (VIETTEL_SINVOICE_ENABLED)',
      );
    }
    const missing = missingViettelSettings(config);
    if (missing.length) {
      throw new BadRequestException(
        `Thiếu cấu hình Viettel S-Invoice: ${missing.join(', ')}`,
      );
    }

    const schoolExpense = await this.schoolExpenses.findOne({
      where: { id: schoolExpenseId },
      relations: { school: true },
    });
    if (!schoolExpense)
      throw new NotFoundException('Không tìm thấy kỳ thu chi');
    if (schoolExpense.finalized) {
      throw new BadRequestException(
        'Kỳ thu chi đã kết thúc — không thể xuất hóa đơn',
      );
    }
    const school = schoolExpense.school;
    if (!school?.taxCode?.trim() || !school.address?.trim()) {
      throw new BadRequestException(
        `Trường "${school?.name ?? ''}" chưa có mã số thuế hoặc địa chỉ — cập nhật hồ sơ trường trước khi xuất hóa đơn`,
      );
    }
    if (!/^\d{7}$/.test(school.budgetCode?.trim() ?? '')) {
      throw new BadRequestException(
        `Trường "${school.name}" chưa có mã đơn vị quan hệ ngân sách (7 chữ số) — cập nhật hồ sơ trường trước khi xuất hóa đơn`,
      );
    }
    const subject = await this.subjects.findOne({
      where: { id: subjectId },
      relations: { catalog: true },
    });
    if (!subject || subject.schoolId !== school.id) {
      throw new NotFoundException('Không tìm thấy môn học của trường');
    }

    const context: ExportContext = {
      schoolExpenseId,
      subjectId,
      subjectName: subject.catalog?.name || subject.name,
      school,
      supplierTaxCode: config.supplierTaxCode,
      templateCode: config.templateCode,
      invoiceSeries: config.invoiceSeries,
      user,
    };

    // Hai lượt bấm cùng lúc (2 tab, 2 instance) chạy lần lượt: lượt sau thấy
    // các dòng đã nằm trong nháp của lượt trước nên không gộp lại lần nữa.
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `revenue_einvoices_${schoolExpenseId}_${subjectId}`,
      ]);
      return this.exportLocked(context);
    });
  }

  /**
   * "Bỏ liên kết nháp": API Viettel không xóa được nháp, kế toán xóa trên
   * portal rồi bấm nút này để các dòng đẩy lại được (và mở khóa dòng). Chặn
   * nếu hóa đơn đã được phát hành — đẩy lại sẽ thành hóa đơn trùng.
   */
  async unlink(
    schoolExpenseId: number,
    subjectId: number,
    einvoiceId: number,
    user: AuthUser,
  ): Promise<{ rowIndexes: number[] }> {
    const schoolExpense = await this.schoolExpenses.findOne({
      where: { id: schoolExpenseId },
    });
    if (!schoolExpense)
      throw new NotFoundException('Không tìm thấy kỳ thu chi');
    if (schoolExpense.finalized) {
      throw new BadRequestException(
        'Kỳ thu chi đã kết thúc — không thể bỏ liên kết hóa đơn',
      );
    }
    const { supplierTaxCode } = getViettelSinvoiceConfig(this.configService);

    return this.dataSource.transaction(async (manager) => {
      // Cùng khóa với "Đẩy hóa đơn" — không bỏ liên kết giữa lúc đang đẩy.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `revenue_einvoices_${schoolExpenseId}_${subjectId}`,
      ]);
      const record = await this.einvoices.findOneBy({
        id: einvoiceId,
        schoolExpenseId,
        subjectId,
        supplierTaxCode,
        status: RevenueEInvoiceStatus.DraftCreated,
      });
      if (!record) throw new NotFoundException('Không tìm thấy hóa đơn nháp');

      let issued: ViettelIssuedInvoice[];
      try {
        issued = await this.viettel.searchIssuedInvoices(
          record.transactionUuid,
        );
      } catch (error) {
        if (!(error instanceof ViettelSinvoiceError)) throw error;
        throw new BadRequestException(
          `Không kiểm tra được hóa đơn trên Viettel: ${error.message}`,
        );
      }
      if (issued.length) {
        throw new BadRequestException(
          `Hóa đơn đã được phát hành trên Viettel (số ${issued
            .map((i) => i.invoiceNo)
            .join(', ')}) — không thể bỏ liên kết`,
        );
      }

      const rowIndexes = linesOf(record).map((line) => line.rowIndex);
      await this.einvoices.delete({ id: record.id });
      if (rowIndexes.length) {
        const revenues = await this.revenueItems.find({
          where: {
            schoolExpense: { id: schoolExpenseId },
            subject: { id: subjectId },
            rowIndex: In(rowIndexes),
          },
          select: { id: true },
        });
        if (revenues.length) {
          await this.revenueItems.update(
            { id: In(revenues.map((r) => r.id)) },
            { invoiceLocked: false },
          );
        }
      }
      this.logger.log(
        `Bỏ liên kết hóa đơn nháp #${record.id} (kỳ ${schoolExpenseId}, môn ${subjectId}, dòng ${rowNumbers(rowIndexes)}, uuid ${record.transactionUuid}) — ${user.name ?? user.id}`,
      );
      return { rowIndexes };
    });
  }

  private async exportLocked(
    context: ExportContext,
  ): Promise<ExportDraftsSummary> {
    const rowFilter = {
      schoolExpense: { id: context.schoolExpenseId },
      subject: { id: context.subjectId },
    };
    const [revenues, schoolRows, records] = await Promise.all([
      this.revenueItems.find({ where: rowFilter, order: { rowIndex: 'ASC' } }),
      this.schoolItems.find({ where: rowFilter }),
      this.einvoices.find({
        where: {
          schoolExpenseId: context.schoolExpenseId,
          subjectId: context.subjectId,
        },
        order: { id: 'ASC' },
      }),
    ]);
    const schoolRowByIndex = new Map(schoolRows.map((r) => [r.rowIndex, r]));
    const companyRows = new Map<number, CompanyRow>(
      revenues
        .filter((r) => r.invoiceType === RevenueInvoiceType.Company)
        .map((revenue) => [
          revenue.rowIndex,
          { revenue, schoolRow: schoolRowByIndex.get(revenue.rowIndex) },
        ]),
    );

    // Nháp ở tài khoản Viettel khác (vd: test → chính thức) không tính: với tài
    // khoản đang cấu hình, các dòng đó chưa có hóa đơn.
    const drafted = records.filter(
      (r) =>
        r.status === RevenueEInvoiceStatus.DraftCreated &&
        r.supplierTaxCode === context.supplierTaxCode,
    );
    const existing = drafted.map((record) =>
      this.compareDrafted(context, record, companyRows),
    );
    const covered = new Set(
      drafted.flatMap((r) => linesOf(r).map((line) => line.rowIndex)),
    );

    const items: InvoiceItem[] = [];
    const unsaved: number[] = [];
    const skipped: SkippedRow[] = [];
    for (const [rowIndex, row] of companyRows) {
      if (covered.has(rowIndex)) continue;
      if (!row.schoolRow) {
        unsaved.push(rowIndex);
        continue;
      }
      const item = this.invoiceItem(context, row.revenue, row.schoolRow);
      if (item.quantity <= 0 || item.amount <= 0) {
        skipped.push({
          rowIndex,
          itemName: item.itemName,
          message: 'Thành tiền bằng 0 hoặc âm — không đưa vào hóa đơn',
        });
        continue;
      }
      items.push(item);
    }

    let draft: InvoiceExportResult | null = null;
    if (unsaved.length) {
      // Không tách dòng thiếu dữ liệu ra hóa đơn khác — các dòng phải lên cùng 1 hóa đơn.
      draft = {
        rowIndexes: unsaved,
        amount: null,
        status: 'error',
        message: `Dòng ${rowNumbers(unsaved)} chưa có dữ liệu Chi Trường — hãy lưu trước khi đẩy hóa đơn`,
      };
    } else if (items.length) {
      // Lần đẩy trước chưa thành công: dùng lại transactionUuid của nó.
      const pending = records.find(
        (r) =>
          r.status !== RevenueEInvoiceStatus.DraftCreated &&
          r.legacyRowIndex == null,
      );
      draft = await this.sendDraft(context, items, pending, companyRows);
    }

    return { draft, existing, skipped };
  }

  private invoiceItem(
    context: ExportContext,
    revenue: RevenueItem,
    schoolRow: SchoolExpenseItem,
  ): InvoiceItem {
    return {
      rowIndex: revenue.rowIndex,
      itemName: invoiceItemName(context.subjectName, revenue.content),
      unitName: revenue.invoiceUnit?.trim() || DEFAULT_INVOICE_UNIT,
      ...invoiceLine(revenue, schoolRow),
    };
  }

  private buildPayload(
    context: ExportContext,
    transactionUuid: string,
    items: InvoiceItem[],
  ): ViettelInvoicePayload {
    return buildDraftPayload({
      transactionUuid,
      templateCode: context.templateCode,
      invoiceSeries: context.invoiceSeries,
      school: {
        id: context.school.id,
        name: context.school.name,
        taxCode: context.school.taxCode,
        budgetCode: context.school.budgetCode,
        address: context.school.address,
        phone: context.school.phone,
        representative: context.school.representative,
      },
      items,
    });
  }

  /** Dựng lại hóa đơn từ dữ liệu hiện tại của các dòng trên nháp rồi so với lần gửi. */
  private compareDrafted(
    context: ExportContext,
    record: RevenueEInvoice,
    companyRows: Map<number, CompanyRow>,
  ): InvoiceExportResult {
    const rowIndexes = linesOf(record).map((line) => line.rowIndex);
    const result = (status: InvoiceExportStatus, message?: string) => ({
      rowIndexes,
      amount: Number(record.amount),
      status,
      message,
    });
    const items: InvoiceItem[] = [];
    for (const rowIndex of rowIndexes) {
      const row = companyRows.get(rowIndex);
      // Dòng đã xóa hoặc không còn "Xuất HĐ Cty".
      if (!row?.schoolRow) return result('changed', DRAFT_CHANGED_MESSAGE);
      items.push(this.invoiceItem(context, row.revenue, row.schoolRow));
    }
    const hash = payloadHash(
      this.buildPayload(context, record.transactionUuid, items),
    );
    return hash === record.payloadHash
      ? result('unchanged', 'Đã có hóa đơn nháp, dữ liệu không đổi')
      : result('changed', DRAFT_CHANGED_MESSAGE);
  }

  private async sendDraft(
    context: ExportContext,
    items: InvoiceItem[],
    pending: RevenueEInvoice | undefined,
    companyRows: Map<number, CompanyRow>,
  ): Promise<InvoiceExportResult> {
    const record =
      pending ??
      this.einvoices.create({
        schoolExpenseId: context.schoolExpenseId,
        subjectId: context.subjectId,
        legacyRowIndex: null,
        supplierTaxCode: context.supplierTaxCode,
        transactionUuid: randomUUID(),
        status: RevenueEInvoiceStatus.Failed,
        lines: [],
        payloadHash: null,
      });
    if (record.supplierTaxCode !== context.supplierTaxCode) {
      // Lần đẩy lỗi ở tài khoản Viettel khác: bắt đầu lại ở tài khoản đang cấu hình.
      Object.assign(record, {
        supplierTaxCode: context.supplierTaxCode,
        transactionUuid: randomUUID(),
        lines: [],
        payloadHash: null,
        viettelTransactionId: null,
        rawResponse: null,
      });
    }

    const payload = this.buildPayload(context, record.transactionUuid, items);
    const hash = payloadHash(payload);
    const amount = payload.summarizeInfo.totalAmountWithTax;
    // Lần gửi trước (nếu có) — Viettel có thể đã tạo nháp dù mình nhận lỗi (vd: timeout).
    const previous = {
      lines: record.lines,
      amount: record.amount,
      payloadHash: record.payloadHash,
      rawRequest: record.rawRequest,
    };
    Object.assign(record, {
      lines: items,
      amount: String(amount),
      buyerName: context.school.name,
      buyerTaxCode: context.school.taxCode.trim(),
      payloadHash: hash,
      rawRequest: payload as unknown as Record<string, unknown>,
      exportedBy: context.user.id ?? null,
      exportedByName: context.user.name ?? null,
    });
    const result = (status: InvoiceExportStatus, message?: string) => ({
      rowIndexes: record.lines.map((line) => line.rowIndex),
      amount: Number(record.amount),
      status,
      message,
    });

    try {
      const response = await this.viettel.createOrUpdateInvoiceDraft(payload);
      await this.markDrafted(record, response, companyRows);
      return result('created');
    } catch (error) {
      if (
        error instanceof ViettelSinvoiceError &&
        error.code === TRANSACTION_UUID_USED
      ) {
        // Viettel chỉ khóa uuid khi đã tạo nháp → lần gửi trước thực ra đã thành công.
        const draftHash = previous.payloadHash ?? hash;
        // Nháp trên Viettel mang số liệu của lần gửi trước, không phải lần này;
        // dòng mới thêm sau lần đó sẽ vào hóa đơn khác ở lần đẩy sau.
        if (draftHash !== hash) Object.assign(record, previous);
        await this.markDrafted(record, null, companyRows);
        return draftHash === hash
          ? result('created', 'Viettel đã có hóa đơn nháp từ lần gửi trước')
          : result('changed', DRAFT_CHANGED_MESSAGE);
      }
      const viettelError =
        error instanceof ViettelSinvoiceError
          ? error
          : new ViettelSinvoiceError(
              'UNKNOWN',
              'Lỗi hệ thống khi gửi hóa đơn nháp',
            );
      if (!(error instanceof ViettelSinvoiceError)) {
        this.logger.error(
          `Xuất hóa đơn nháp lỗi (kỳ ${context.schoolExpenseId}, môn ${context.subjectId}, dòng ${rowNumbers(items.map((i) => i.rowIndex))})`,
          error instanceof Error ? error.stack : undefined,
        );
      }
      Object.assign(record, {
        status: RevenueEInvoiceStatus.Failed,
        errorCode: viettelError.code,
        errorMessage: viettelError.message,
        rawResponse: null,
      });
      await this.einvoices.save(record);
      return result('error', viettelError.message);
    }
  }

  private async markDrafted(
    record: RevenueEInvoice,
    response: ViettelDraftResult | null,
    companyRows: Map<number, CompanyRow>,
  ): Promise<void> {
    Object.assign(record, {
      status: RevenueEInvoiceStatus.DraftCreated,
      viettelTransactionId:
        response?.transactionID ?? record.viettelTransactionId ?? null,
      errorCode: null,
      errorMessage: null,
      rawResponse: (response ?? null) as Record<string, unknown> | null,
      draftedAt: new Date(),
    });
    await this.einvoices.save(record);
    // Đã có hóa đơn thì khóa các dòng doanh thu trên hóa đơn.
    const revenueIds = record.lines
      .map((line) => companyRows.get(line.rowIndex)?.revenue.id)
      .filter((id): id is number => id != null);
    if (revenueIds.length) {
      await this.revenueItems.update(
        { id: In(revenueIds) },
        { invoiceLocked: true },
      );
    }
  }
}

function payloadHash(payload: ViettelInvoicePayload): string {
  const general: Partial<ViettelInvoicePayload['generalInvoiceInfo']> = {
    ...payload.generalInvoiceInfo,
  };
  delete general.transactionUuid;
  return createHash('sha256')
    .update(JSON.stringify({ ...payload, generalInvoiceInfo: general }))
    .digest('hex');
}
