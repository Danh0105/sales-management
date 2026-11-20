import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as ExcelJS from 'exceljs';
import { In, Repository, SelectQueryBuilder } from 'typeorm';

import { AuthUser } from '../type/auth-user.type';
import {
  FinancialReportQueryDto,
  FinancialRequestQueryDto,
} from './dto/financial-request.dto';
import { FinancialPayment } from './entities/financial-payment.entity';
import { FinancialRequestItem } from './entities/financial-request-item.entity';
import { FinancialRequest } from './entities/financial-request.entity';
import { vnToday } from './financial-calculations';
import {
  FinanceContext,
  FinancialAccessService,
} from './financial-access.service';
import { payableDue, receivableDue } from './financial-ledger.service';
import {
  ApprovalStatus,
  FinanceRole,
  FinancialRequestType,
  MovementStatus,
  REQUEST_TYPE_LABELS,
} from './financial-request.constants';
import { FinancialRequestService } from './financial-request.service';
import { sumMoney } from './financial-money';

const APPROVAL_LABELS: Record<string, string> = {
  DRAFT: 'Nháp',
  PENDING: 'Chờ duyệt',
  RETURNED: 'Yêu cầu bổ sung',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Từ chối',
  CANCELLED: 'Đã huỷ',
};

const PAYMENT_LABELS: Record<string, string> = {
  NONE: '',
  UNPAID: 'Chờ chi tiền',
  PARTIALLY_PAID: 'Đã chi một phần',
  PAID: 'Đã chi đủ',
};

const SUBMITTED = [
  ApprovalStatus.PENDING,
  ApprovalStatus.RETURNED,
  ApprovalStatus.APPROVED,
];

@Injectable()
export class FinancialReportService {
  constructor(
    private readonly access: FinancialAccessService,
    private readonly requests: FinancialRequestService,
    @InjectRepository(FinancialRequest)
    private readonly requestRepo: Repository<FinancialRequest>,
    @InjectRepository(FinancialRequestItem)
    private readonly itemRepo: Repository<FinancialRequestItem>,
    @InjectRepository(FinancialPayment)
    private readonly paymentRepo: Repository<FinancialPayment>,
  ) {}

  private scoped(ctx: FinanceContext, query: FinancialReportQueryDto) {
    const qb = this.requestRepo.createQueryBuilder('r');
    this.access.applyVisibility(qb, ctx);
    qb.andWhere('r.approval_status <> :draft', { draft: ApprovalStatus.DRAFT });
    if (query.companyId)
      qb.andWhere('r.company_id = :companyId', { companyId: query.companyId });
    if (query.departmentId)
      qb.andWhere('r.department_id = :departmentId', {
        departmentId: query.departmentId,
      });
    if (query.requesterId)
      qb.andWhere('r.requester_id = :requesterId', {
        requesterId: query.requesterId,
      });
    if (query.type) qb.andWhere('r.type = :type', { type: query.type });
    return qb;
  }

  private inPeriod(
    qb: SelectQueryBuilder<FinancialRequest>,
    column: string,
    query: FinancialReportQueryDto,
  ) {
    if (query.dateFrom)
      qb.andWhere(`${column} >= :dateFrom`, { dateFrom: query.dateFrom });
    if (query.dateTo)
      qb.andWhere(`${column} < (:dateTo::date + 1)`, { dateTo: query.dateTo });
    return qb;
  }

  /** Dashboard: 10 chỉ số + biểu đồ, chỉ trên các phiếu người xem được phép thấy. */
  async summary(user: AuthUser, query: FinancialReportQueryDto) {
    const ctx = await this.access.context(user);
    const today = vnToday();
    // Điều chuyển tiền nội bộ không phải chi phí/tạm ứng — không vào dashboard.
    const scoped = () =>
      this.scoped(ctx, query).andWhere('r.type <> :internalTransfer', {
        internalTransfer: FinancialRequestType.INTERNAL_TRANSFER,
      });

    // Phiếu phát sinh trong kỳ (theo ngày đề nghị).
    const inPeriod = await this.inPeriod(
      scoped(),
      'r.request_date',
      query,
    )
      .leftJoinAndSelect('r.company', 'company')
      .getMany();
    // Số dư hiện tại: mọi phiếu đã duyệt trong phạm vi (không giới hạn kỳ).
    const approvedAll = await scoped()
      .andWhere('r.approval_status = :approved', {
        approved: ApprovalStatus.APPROVED,
      })
      .getMany();

    const submitted = inPeriod.filter((r) =>
      SUBMITTED.includes(r.approvalStatus),
    );
    const approved = inPeriod.filter(
      (r) => r.approvalStatus === ApprovalStatus.APPROVED,
    );

    const visibleIds = (
      await scoped()
        .select('r.id', 'id')
        .getRawMany<{ id: number }>()
    ).map((row) => Number(row.id));
    const paymentsQb = this.paymentRepo
      .createQueryBuilder('p')
      .where('p.status = :recorded', { recorded: MovementStatus.RECORDED });
    if (visibleIds.length)
      paymentsQb.andWhere('p.request_id IN (:...ids)', { ids: visibleIds });
    else paymentsQb.andWhere('FALSE');
    if (query.dateFrom)
      paymentsQb.andWhere('p.paid_at >= :dateFrom', {
        dateFrom: query.dateFrom,
      });
    if (query.dateTo)
      paymentsQb.andWhere('p.paid_at <= :dateTo', { dateTo: query.dateTo });
    const payments = await paymentsQb.getMany();
    const typeById = new Map<number, FinancialRequestType>();
    for (const r of [...inPeriod, ...approvedAll]) typeById.set(r.id, r.type);
    const missing = [...new Set(payments.map((p) => p.requestId))].filter(
      (id) => !typeById.has(id),
    );
    if (missing.length) {
      for (const r of await this.requestRepo.find({
        where: { id: In(missing) },
        select: ['id', 'type'],
      })) {
        typeById.set(r.id, r.type);
      }
    }

    const settlementsApproved = approvedAll.filter(
      (r) =>
        r.type === FinancialRequestType.SETTLEMENT &&
        r.approvedAt &&
        (!query.dateFrom ||
          r.approvedAt.toISOString().slice(0, 10) >= query.dateFrom) &&
        (!query.dateTo ||
          r.approvedAt.toISOString().slice(0, 10) <= query.dateTo),
    );

    const pendingCount = await scoped()
      .andWhere('r.approval_status = :pending', {
        pending: ApprovalStatus.PENDING,
      })
      .getCount();

    const kpis = {
      totalRequested: sumMoney(submitted.map((r) => r.totalAmount)),
      totalApproved: sumMoney(approved.map((r) => r.approvedAmount ?? 0)),
      totalPaid: sumMoney(payments.map((p) => p.amount)),
      advanceOutstanding: sumMoney(
        approvedAll
          .filter((r) => r.type === FinancialRequestType.ADVANCE)
          .map((r) => Math.max(r.paidAmount - r.settledAmount, 0)),
      ),
      settledInPeriod: sumMoney(
        settlementsApproved.map((r) => r.approvedAmount ?? 0),
      ),
      payableToEmployees: sumMoney(
        approvedAll.map((r) => Math.max(payableDue(r) - r.paidAmount, 0)),
      ),
      receivable: sumMoney(
        approvedAll.map((r) =>
          Math.max(receivableDue(r) - r.recoveredAmount, 0),
        ),
      ),
      salaryAdvanceOutstanding: sumMoney(
        approvedAll
          .filter((r) => r.type === FinancialRequestType.SALARY_ADVANCE)
          .map((r) => Math.max(r.paidAmount - r.deductedAmount, 0)),
      ),
      pendingCount,
      overdueAdvanceCount: approvedAll.filter(
        (r) =>
          r.type === FinancialRequestType.ADVANCE &&
          r.paidAmount > r.settledAmount &&
          !!r.settlementDueDate &&
          r.settlementDueDate < today,
      ).length,
    };

    // ---- Biểu đồ ----
    const month = (value: string | Date) =>
      (typeof value === 'string' ? value : value.toISOString()).slice(0, 7);
    const byMonth = new Map<
      string,
      { month: string; requested: number; approved: number; paid: number }
    >();
    const monthRow = (key: string) => {
      if (!byMonth.has(key))
        byMonth.set(key, { month: key, requested: 0, approved: 0, paid: 0 });
      return byMonth.get(key)!;
    };
    for (const r of submitted)
      monthRow(month(r.requestDate)).requested += r.totalAmount;
    for (const r of approved)
      monthRow(month(r.requestDate)).approved += r.approvedAmount ?? 0;
    for (const p of payments) monthRow(month(p.paidAt)).paid += p.amount;

    const advanceVsSettlement = new Map<
      string,
      { month: string; advancePaid: number; settled: number }
    >();
    const avsRow = (key: string) => {
      if (!advanceVsSettlement.has(key))
        advanceVsSettlement.set(key, {
          month: key,
          advancePaid: 0,
          settled: 0,
        });
      return advanceVsSettlement.get(key)!;
    };
    for (const p of payments) {
      if (typeById.get(p.requestId) === FinancialRequestType.ADVANCE)
        avsRow(month(p.paidAt)).advancePaid += p.amount;
    }
    for (const r of settlementsApproved)
      avsRow(month(r.approvedAt!)).settled += r.approvedAmount ?? 0;

    const group = <K extends string>(
      rows: FinancialRequest[],
      key: (r: FinancialRequest) => K,
    ) => {
      const map = new Map<K, number>();
      for (const r of rows)
        map.set(key(r), (map.get(key(r)) ?? 0) + (r.approvedAmount ?? 0));
      return [...map.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
    };

    const expenseIds = approved
      .filter((r) =>
        [
          FinancialRequestType.EXPENSE_PAYMENT,
          FinancialRequestType.SETTLEMENT,
        ].includes(r.type),
      )
      .map((r) => r.id);
    const byCategory = expenseIds.length
      ? (
          await this.itemRepo
            .createQueryBuilder('i')
            .select("COALESCE(i.category_name, 'Chưa phân loại')", 'name')
            .addSelect('SUM(COALESCE(i.approved_amount, i.amount))', 'value')
            .where('i.request_id IN (:...ids)', { ids: expenseIds })
            .groupBy("COALESCE(i.category_name, 'Chưa phân loại')")
            .orderBy('value', 'DESC')
            .getRawMany<{ name: string; value: string }>()
        ).map((row) => ({ name: row.name, value: Number(row.value) }))
      : [];

    const statusCounts = Object.keys(APPROVAL_LABELS)
      .filter((status) => status !== 'DRAFT')
      .map((status) => ({
        status,
        label: APPROVAL_LABELS[status],
        count: inPeriod.filter((r) => r.approvalStatus === status).length,
      }));

    return {
      kpis,
      charts: {
        byMonth: [...byMonth.values()].sort((a, b) =>
          a.month.localeCompare(b.month),
        ),
        byCompany: group(
          approved,
          (r) => r.company?.shortName || r.company?.name || `#${r.companyId}`,
        ),
        byDepartment: group(
          approved,
          (r) => r.departmentName || 'Chưa có phòng ban',
        ),
        byCategory,
        byType: group(approved, (r) => REQUEST_TYPE_LABELS[r.type]),
        advanceVsSettlement: [...advanceVsSettlement.values()].sort((a, b) =>
          a.month.localeCompare(b.month),
        ),
        statusCounts,
      },
    };
  }

  /** Excel danh sách theo đúng bộ lọc màn danh sách (tối đa 5.000 phiếu) + sheet chi tiết dòng. */
  async exportList(user: AuthUser, query: FinancialRequestQueryDto) {
    const ctx = await this.access.context(user);
    if (
      (query.scope ?? 'mine') !== 'mine' &&
      !ctx.isAdmin &&
      !this.access.hasAnyRole(ctx, [
        FinanceRole.ACCOUNTANT,
        FinanceRole.DIRECTOR,
        FinanceRole.VIEWER,
        FinanceRole.CONTROLLER,
        FinanceRole.CASHIER,
        FinanceRole.MANAGER,
      ])
    ) {
      throw new ForbiddenException(
        'Bạn chỉ xuất được danh sách phiếu của mình',
      );
    }
    const rows = await this.requests
      .buildListQuery(ctx, query)
      .leftJoinAndSelect('r.company', 'company')
      .orderBy('r.requestDate', 'ASC')
      .addOrderBy('r.id', 'ASC')
      .take(5000)
      .getMany();
    const items = rows.length
      ? await this.itemRepo.find({
          where: { requestId: In(rows.map((r) => r.id)) },
          order: { requestId: 'ASC', lineNo: 'ASC' },
        })
      : [];

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kido Office';
    const money = '#,##0';

    const sheet = workbook.addWorksheet('Đề nghị');
    sheet.columns = [
      { header: 'Mã phiếu', key: 'code', width: 16 },
      { header: 'Ngày đề nghị', key: 'date', width: 13 },
      { header: 'Loại', key: 'type', width: 18 },
      { header: 'Công ty', key: 'company', width: 22 },
      { header: 'Bộ phận', key: 'department', width: 20 },
      { header: 'Người đề nghị', key: 'requester', width: 24 },
      { header: 'Nội dung', key: 'title', width: 40 },
      {
        header: 'Tổng đề nghị',
        key: 'total',
        width: 15,
        style: { numFmt: money },
      },
      {
        header: 'Được duyệt',
        key: 'approved',
        width: 15,
        style: { numFmt: money },
      },
      {
        header: 'Tạm ứng đối trừ',
        key: 'offset',
        width: 15,
        style: { numFmt: money },
      },
      { header: 'Đã chi', key: 'paid', width: 15, style: { numFmt: money } },
      {
        header: 'Đã thu hồi',
        key: 'recovered',
        width: 15,
        style: { numFmt: money },
      },
      {
        header: 'Còn phải chi',
        key: 'payable',
        width: 15,
        style: { numFmt: money },
      },
      {
        header: 'Còn phải thu',
        key: 'receivable',
        width: 15,
        style: { numFmt: money },
      },
      { header: 'Trạng thái duyệt', key: 'approval', width: 16 },
      { header: 'Trạng thái chi', key: 'payment', width: 16 },
    ];
    for (const r of rows) {
      sheet.addRow({
        code: r.code,
        date: r.requestDate,
        type: REQUEST_TYPE_LABELS[r.type],
        company: r.company?.shortName || r.company?.name || '',
        department: r.departmentName ?? '',
        requester: r.requesterName,
        title: r.title,
        total: r.totalAmount,
        approved: r.approvedAmount ?? null,
        offset:
          r.type === FinancialRequestType.SETTLEMENT ? r.offsetAmount : null,
        paid: r.paidAmount,
        recovered: r.recoveredAmount,
        payable: Math.max(payableDue(r) - r.paidAmount, 0),
        receivable: Math.max(receivableDue(r) - r.recoveredAmount, 0),
        approval: APPROVAL_LABELS[r.approvalStatus] ?? r.approvalStatus,
        payment: PAYMENT_LABELS[r.paymentStatus] ?? r.paymentStatus,
      });
    }
    const totalRow = sheet.addRow({
      code: 'TỔNG CỘNG',
      total: sumMoney(rows.map((r) => r.totalAmount)),
      approved: sumMoney(rows.map((r) => r.approvedAmount ?? 0)),
      paid: sumMoney(rows.map((r) => r.paidAmount)),
      recovered: sumMoney(rows.map((r) => r.recoveredAmount)),
      payable: sumMoney(
        rows.map((r) => Math.max(payableDue(r) - r.paidAmount, 0)),
      ),
      receivable: sumMoney(
        rows.map((r) => Math.max(receivableDue(r) - r.recoveredAmount, 0)),
      ),
    });
    totalRow.font = { bold: true };
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const detail = workbook.addWorksheet('Chi tiết dòng');
    detail.columns = [
      { header: 'Mã phiếu', key: 'code', width: 16 },
      { header: 'STT', key: 'line', width: 6 },
      { header: 'Nội dung', key: 'description', width: 40 },
      { header: 'Nhóm chi phí', key: 'category', width: 20 },
      { header: 'ĐVT', key: 'unit', width: 8 },
      {
        header: 'Số lượng',
        key: 'quantity',
        width: 10,
        style: { numFmt: '#,##0.####' },
      },
      {
        header: 'Đơn giá',
        key: 'unitPrice',
        width: 14,
        style: { numFmt: '#,##0.##' },
      },
      {
        header: 'Thành tiền',
        key: 'amount',
        width: 15,
        style: { numFmt: money },
      },
      {
        header: 'Được chấp nhận',
        key: 'approved',
        width: 15,
        style: { numFmt: money },
      },
      { header: 'Ngày phát sinh', key: 'date', width: 13 },
      { header: 'Số hoá đơn', key: 'invoice', width: 14 },
      { header: 'Nhà cung cấp', key: 'supplier', width: 22 },
      { header: 'Ghi chú', key: 'note', width: 30 },
    ];
    const codeById = new Map(rows.map((r) => [r.id, r.code]));
    for (const item of items) {
      detail.addRow({
        code: codeById.get(item.requestId),
        line: item.lineNo,
        description: item.description,
        category: item.categoryName ?? '',
        unit: item.unit ?? '',
        // numeric giữ dạng chuỗi chính xác; Excel nhận số hiển thị.
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        amount: item.amount,
        approved: item.approvedAmount ?? null,
        date: item.incurredDate ?? '',
        invoice: item.invoiceNumber ?? '',
        supplier: item.supplierName ?? '',
        note: item.note ?? '',
      });
    }
    detail.getRow(1).font = { bold: true };
    detail.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return {
      buffer,
      fileName: `de-nghi-tai-chinh-${vnToday()}.xlsx`,
      count: rows.length,
    };
  }
}
