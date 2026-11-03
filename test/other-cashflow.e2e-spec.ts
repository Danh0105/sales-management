/**
 * Kiểm thử tích hợp Thu Chi ngoài trên Postgres THẬT.
 *
 * Chỉ chạy khi đặt `OTHER_CASHFLOW_IT_DB` = tên một database test riêng (đã
 * chạy migration 1794700000000). Guard trong test/setup chặn mọi kết nối tới
 * `sales_db`. Mỗi lần chạy tạo nhân viên/trường mới có hậu tố riêng nên chạy
 * lại nhiều lần không đụng nhau. Không dùng dữ liệu thật.
 *
 *   OTHER_CASHFLOW_IT_DB=sales_occ_test DB_USER=... DB_PASSWORD=... \
 *     npx jest --config ./test/jest-e2e.json test/other-cashflow.e2e-spec.ts
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import {
  mapOtherCashflowEntries,
  OTHER_CASHFLOW_ENTRIES_SQL,
  OtherCashflowEntryRow,
} from '../src/cashflow-report/other-cashflow-source';
import { CashAccount } from '../src/cashflow-report/cash-account.entity';
import { Employee } from '../src/employee/employee.entity';
import { EmployeeFcmTokenService } from '../src/employee-fcm-token/employee-fcm-token.service';
import { FcmService } from '../src/fcm/fcm.service';
import { addDays, vnToday } from '../src/financial-request/financial-calculations';
import { Notification } from '../src/notifications/entities/notification.entity';
import { NotificationService } from '../src/notifications/services/notification.service';
import { OtherCashflowAttachment } from '../src/other-cashflow/entities/other-cashflow-attachment.entity';
import { OtherCashflowContract } from '../src/other-cashflow/entities/other-cashflow-contract.entity';
import { OtherCashflowCost } from '../src/other-cashflow/entities/other-cashflow-cost.entity';
import { OtherCashflowEntry } from '../src/other-cashflow/entities/other-cashflow-entry.entity';
import { OtherCashflowEvent } from '../src/other-cashflow/entities/other-cashflow-event.entity';
import { OtherCashflowItem } from '../src/other-cashflow/entities/other-cashflow-item.entity';
import { OtherCashflowOrder } from '../src/other-cashflow/entities/other-cashflow-order.entity';
import {
  CashflowDirection,
  EntryStatus,
  OrderKind,
  OrderStatus,
  OtherCashflowForm,
  OtherCashflowStatus,
} from '../src/other-cashflow/other-cashflow.constants';
import { OtherCashflowNotifyService } from '../src/other-cashflow/other-cashflow-notify.service';
import { OtherCashflowService } from '../src/other-cashflow/other-cashflow.service';
import { School } from '../src/school/schools.entity';
import { AuthUser } from '../src/type/auth-user.type';

const DB = process.env.OTHER_CASHFLOW_IT_DB;
const suite = DB ? describe : describe.skip;

jest.setTimeout(120_000);

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
  'latin1',
);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

function file(name: string, buffer: Buffer): Express.Multer.File {
  return {
    originalname: name,
    buffer,
    size: buffer.length,
  } as Express.Multer.File;
}

suite('Thu Chi ngoài — tích hợp trên Postgres', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let service: OtherCashflowService;
  const notification = {
    createNotifications: jest.fn().mockResolvedValue([]),
  };
  const run = Date.now().toString(36);
  const storageDir = mkdtempSync(join(tmpdir(), 'occ-it-'));
  let key = 0;
  const idem = () => `occ-it-${run}-${++key}`;
  let schoolId = 0;

  const U: Record<string, AuthUser> = {};

  async function employee(label: string, roles: string[]) {
    const [row] = await ds.query(
      `INSERT INTO employee (name, phone, roles) VALUES ($1, $2, $3) RETURNING id`,
      [`${label} ${run}`, `08${run}${label}`.slice(0, 20), roles],
    );
    // Token cố tình không có tên — service phải lấy tên từ bảng employee.
    U[label] = { id: row.id, roles };
  }

  const sentTo = (action: string) =>
    notification.createNotifications.mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg.meta?.action === action);

  /** Một khoản thu SL 1 × số tiền, không thuế. */
  const income = (amount: number, itemName = 'Cho thuê sân bóng') => [
    { itemName, quantity: '1', unitPrice: String(amount) },
  ];

  async function newContract(
    by: AuthUser = U.A,
    extra: Partial<Parameters<OtherCashflowService['create']>[1]> = {},
  ) {
    return service.create(by, {
      title: 'Cho thuê sân bóng',
      partnerName: 'Công ty Thử nghiệm',
      items: income(3_000_000),
      ...extra,
    });
  }

  async function approved(extra: Partial<Parameters<OtherCashflowService['create']>[1]> = {}) {
    const created = await newContract(U.A, extra);
    return service.review(U.D, created.id, {
      decision: OtherCashflowStatus.APPROVED,
    });
  }

  beforeAll(async () => {
    process.env.FINANCIAL_STORAGE_DIR = storageDir;
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: Number(process.env.DB_PORT || 5432),
          username: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: DB,
          entities: [join(__dirname, '../src/**/*.entity.ts')],
          synchronize: false,
        }),
        TypeOrmModule.forFeature([
          OtherCashflowContract,
          OtherCashflowEntry,
          OtherCashflowAttachment,
          OtherCashflowEvent,
          OtherCashflowItem,
          OtherCashflowCost,
          OtherCashflowOrder,
          Employee,
          School,
          CashAccount,
          Notification,
        ]),
      ],
      providers: [
        OtherCashflowService,
        OtherCashflowNotifyService,
        { provide: NotificationService, useValue: notification },
        { provide: FcmService, useValue: { sendToMultiple: jest.fn() } },
        {
          provide: EmployeeFcmTokenService,
          useValue: { getTokens: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();
    ds = moduleRef.get(getDataSourceToken());
    service = moduleRef.get(OtherCashflowService);

    await employee('A', ['sales']); // người lập
    await employee('B', ['employee']); // NV kinh doanh khác
    await employee('D', ['director']);
    await employee('L', ['director_la']);
    await employee('T', ['thuquy']);
    await employee('C', ['ketoan_congno']);
    await employee('K', ['ketoan_truong']);
    await employee('G', ['giaovien_ctv']); // không liên quan
    await ds.query(
      `INSERT INTO cash_accounts (code, name, "groupCode") VALUES
         ('1111', 'Tiền mặt tại quỹ', '111'),
         ('1121', 'Tiền gửi ngân hàng', '112')
       ON CONFLICT (code) DO NOTHING`,
    );
    [{ id: schoolId }] = await ds.query(
      `INSERT INTO schools (name) VALUES ($1) RETURNING id`,
      [`Trường OCC ${run}`],
    );
  });

  afterAll(async () => {
    await moduleRef?.close();
    rmSync(storageDir, { recursive: true, force: true });
  });

  beforeEach(() => notification.createNotifications.mockClear());

  it('NV kinh doanh lập hợp đồng → chờ duyệt, báo mọi giám đốc', async () => {
    const created = await newContract(U.A, {
      schoolId,
      signedDate: '2026-10-01',
      expectedDate: '2026-11-15',
      note: 'Thu theo 3 đợt',
    });
    expect(created).toMatchObject({
      status: OtherCashflowStatus.PENDING,
      code: `TCN-${String(created.id).padStart(5, '0')}`,
      direction: null,
      amount: 3_000_000,
      costAmount: 0,
      profit: 3_000_000,
      recordedAmount: 0,
      remainingAmount: 3_000_000,
      createdById: U.A.id,
      createdByName: `A ${run}`,
      school: { id: schoolId, name: `Trường OCC ${run}` },
      signedDate: '2026-10-01',
    });
    expect(created.permissions).toMatchObject({
      canEdit: true,
      canReview: false,
      canRecord: false,
    });
    expect(created.events.map((e) => e.action)).toEqual(['SUBMITTED']);
    const [sent] = sentTo('REVIEW_REQUIRED');
    expect(sent.receiverIds).toEqual(expect.arrayContaining([U.D.id, U.L.id]));
    expect(sent.receiverIds).not.toContain(U.A.id);
    expect(sent.entityId).toBeUndefined();
    expect(sent.meta).toMatchObject({ kind: 'other_cashflow', contractId: created.id });
  });

  it('chỉ NV kinh doanh lập được; người ngoài không vào được phân hệ', async () => {
    await expect(newContract(U.D)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(newContract(U.T)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(newContract(U.K)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.list(U.G, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(newContract(U.A, { schoolId: 2_000_000_000 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('NV kinh doanh chỉ thấy hợp đồng của mình; giám đốc/thủ quỹ/KTT thấy tất cả', async () => {
    const mine = await newContract(U.A);
    const other = await newContract(U.B, { title: `Riêng B ${run}` });
    await expect(service.detail(U.B, mine.id)).rejects.toBeInstanceOf(NotFoundException);
    const listB = await service.list(U.B, { limit: 100 });
    expect(listB.data.every((c) => c.createdById === U.B.id)).toBe(true);
    expect(listB.meta).toMatchObject({ canCreate: true, canApprove: false });
    for (const viewer of [U.D, U.T, U.K]) {
      const found = await service.list(viewer, { search: `Riêng B ${run}` });
      expect(found.data.map((c) => c.id)).toEqual([other.id]);
    }
    const byCode = await service.list(U.D, { search: other.code });
    expect(byCode.data.map((c) => c.id)).toEqual([other.id]);
    const pending = await service.list(U.D, { status: OtherCashflowStatus.PENDING, limit: 100 });
    expect(pending.data.every((c) => c.status === OtherCashflowStatus.PENDING)).toBe(true);
    expect(pending.counts.PENDING).toBeGreaterThanOrEqual(2);
    expect(pending.meta).toMatchObject({ canApprove: true, canCreate: false });
  });

  it('từ chối cần lý do → người lập sửa và gửi lại → chờ duyệt lại', async () => {
    const created = await newContract();
    await expect(
      service.review(U.D, created.id, { decision: OtherCashflowStatus.REJECTED }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.review(U.A, created.id, { decision: OtherCashflowStatus.APPROVED }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const rejected = await service.review(U.D, created.id, {
      decision: OtherCashflowStatus.REJECTED,
      note: 'Thiếu hợp đồng ký',
    });
    expect(rejected).toMatchObject({
      status: OtherCashflowStatus.REJECTED,
      reviewNote: 'Thiếu hợp đồng ký',
      reviewedById: U.D.id,
    });
    const [toCreator] = sentTo('REJECTED');
    expect(toCreator.receiverIds).toEqual([U.A.id]);
    expect(toCreator.message).toContain('Thiếu hợp đồng ký');

    await expect(
      service.update(U.B, created.id, { items: income(1) }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    notification.createNotifications.mockClear();
    const resubmitted = await service.update(U.A, created.id, {
      items: income(2_500_000),
      schoolId,
    });
    expect(resubmitted).toMatchObject({
      status: OtherCashflowStatus.PENDING,
      amount: 2_500_000,
      reviewNote: null,
      reviewedById: null,
      school: { id: schoolId },
    });
    expect(resubmitted.events.map((e) => e.action)).toEqual([
      'SUBMITTED',
      'REJECTED',
      'RESUBMITTED',
    ]);
    expect(sentTo('REVIEW_REQUIRED')[0].message).toContain('đã sửa và gửi lại');

    // Sửa khi đang chờ duyệt: không gửi thông báo trùng.
    notification.createNotifications.mockClear();
    const edited = await service.update(U.A, created.id, { schoolId: null });
    expect(edited.school).toBeNull();
    expect(notification.createNotifications).not.toHaveBeenCalled();
  });

  it('duyệt → báo người lập và thủ quỹ; đánh dấu đã đọc thông báo "cần duyệt" (không đụng chính sách thật)', async () => {
    const created = await newContract();
    const [{ id: reviewNoti }] = await ds.query(
      `INSERT INTO notification ("receiverId", type, meta, message)
       VALUES ($1, 'POLICY', $2, 'cần duyệt') RETURNING id`,
      [U.L.id, JSON.stringify({ kind: 'other_cashflow', action: 'REVIEW_REQUIRED', contractId: created.id })],
    );
    const [{ id: policyNoti }] = await ds.query(
      `INSERT INTO notification ("receiverId", type, "entityId", message)
       VALUES ($1, 'POLICY', $2, 'chính sách thật') RETURNING id`,
      [U.L.id, created.id],
    );
    const result = await service.review(U.D, created.id, {
      decision: OtherCashflowStatus.APPROVED,
      note: 'OK',
    });
    expect(result.status).toBe(OtherCashflowStatus.APPROVED);
    expect(sentTo('APPROVED')[0].receiverIds).toEqual([U.A.id]);
    expect(sentTo('RECORD_REQUIRED')[0].receiverIds).toContain(U.T.id);
    const rows: { id: number; isRead: boolean }[] = await ds.query(
      `SELECT id, "isRead" FROM notification WHERE id = ANY($1)`,
      [[reviewNoti, policyNoti]],
    );
    expect(rows.find((r) => r.id === reviewNoti)?.isRead).toBe(true);
    expect(rows.find((r) => r.id === policyNoti)?.isRead).toBe(false);

    await expect(
      service.review(U.L, created.id, { decision: OtherCashflowStatus.REJECTED, note: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(U.A, created.id, { items: income(1) })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('thủ quỹ ghi nhận nhiều lần tới khi đủ; chống trùng; không vượt số còn lại', async () => {
    const contract = await approved();
    const record = (amount: number, extra: Record<string, unknown> = {}) =>
      service.recordEntry(U.T, contract.id, {
        flow: CashflowDirection.IN,
        date: '2026-10-29',
        amount,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
        ...extra,
      });

    const pendingOne = await newContract();
    await expect(
      service.recordEntry(U.T, pendingOne.id, {
        flow: CashflowDirection.IN,
        date: '2026-10-29',
        amount: 1,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.recordEntry(U.D, contract.id, {
        flow: CashflowDirection.IN,
        date: '2026-10-29',
        amount: 1,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(record(1, { cashAccountCode: '9999' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(record(1, { date: addDays(vnToday(), 1) })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const firstKey = idem();
    const first = await record(1_000_000, { idempotencyKey: firstKey });
    const replay = await record(1_000_000, { idempotencyKey: firstKey });
    expect(replay.id).toBe(first.id);
    let detail = await service.detail(U.A, contract.id);
    expect(detail).toMatchObject({
      status: OtherCashflowStatus.IN_PROGRESS,
      recordedAmount: 1_000_000,
      remainingAmount: 2_000_000,
    });
    expect(sentTo('RECORDED')).toHaveLength(1);
    expect(sentTo('RECORDED')[0].receiverIds).toEqual([U.A.id]);

    await expect(record(2_000_001)).rejects.toBeInstanceOf(BadRequestException);

    // Hai lần bấm song song cùng số còn lại: khoá dòng → chỉ một lần được ghi.
    const results = await Promise.allSettled([
      record(2_000_000, { cashAccountCode: '1121' }),
      record(2_000_000, { cashAccountCode: '1121' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    detail = await service.detail(U.T, contract.id);
    expect(detail).toMatchObject({
      status: OtherCashflowStatus.COMPLETED,
      recordedAmount: 3_000_000,
      remainingAmount: 0,
    });
    expect(detail.permissions.canRecord).toBe(false);
    await expect(record(1)).rejects.toBeInstanceOf(BadRequestException);

    // Huỷ lần ghi nhận → quay lại "đang thu/chi"; huỷ lần nữa → 409.
    const voided = await service.voidEntry(U.T, contract.id, first.id, {
      reason: 'Ghi nhầm tài khoản',
    });
    expect(voided).toMatchObject({
      status: OtherCashflowStatus.IN_PROGRESS,
      recordedAmount: 2_000_000,
    });
    expect(voided.entries.find((e) => e.id === first.id)).toMatchObject({
      status: EntryStatus.VOIDED,
      voidReason: 'Ghi nhầm tài khoản',
      voidedById: U.T.id,
    });
    await expect(
      service.voidEntry(U.T, contract.id, first.id, { reason: 'lại' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.voidEntry(U.D, contract.id, first.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Báo cáo thu chi: chỉ lần ghi nhận còn hiệu lực, đúng tài khoản/hướng.
    const rows = await ds.query<OtherCashflowEntryRow[]>(OTHER_CASHFLOW_ENTRIES_SQL);
    const lines = mapOtherCashflowEntries(rows).lines.filter(
      (line) => line.source.otherCashflowId === contract.id,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      accountCode: '1121',
      postingDate: '2026-10-29',
      receipt: 200_000_000n,
      payment: 0n,
      documentNo: contract.code,
    });
  });

  it('hợp đồng chỉ có khoản chi vào báo cáo thành bút toán chi', async () => {
    const contract = await approved({
      items: [],
      costs: [{ description: 'Thuê xe đưa đón', quantity: '1', unitPrice: '500000' }],
    });
    expect(contract).toMatchObject({ amount: 0, costAmount: 500_000, profit: -500_000 });
    await service.recordEntry(U.T, contract.id, {
      flow: CashflowDirection.OUT,
      costId: contract.costs[0].id,
      date: '2026-10-30',
      amount: 500_000,
      cashAccountCode: '1111',
      idempotencyKey: idem(),
    });
    const detail = await service.detail(U.A, contract.id);
    expect(detail).toMatchObject({ status: OtherCashflowStatus.COMPLETED, paidCostAmount: 500_000 });
    const rows = await ds.query<OtherCashflowEntryRow[]>(OTHER_CASHFLOW_ENTRIES_SQL);
    const [line] = mapOtherCashflowEntries(rows).lines.filter(
      (l) => l.source.otherCashflowId === contract.id,
    );
    expect(line).toMatchObject({ receipt: 0n, payment: 50_000_000n, accountCode: '1111' });
  });

  it('gộp thu chi có thuế: lợi nhuận = thu chưa thuế − chi chưa thuế; thủ quỹ thu tổng, chi từng khoản', async () => {
    const contract = await approved({
      title: 'Liên kết dạy kỹ năng',
      items: [
        { itemName: 'Học phí kỹ năng', unit: 'học sinh', quantity: '50', unitPrice: '200000', vatRate: 10 },
        { itemName: 'Tài liệu', quantity: '50', unitPrice: '40000' },
      ],
      costs: [
        { description: 'Thù lao giáo viên', payee: 'GV Thử nghiệm', quantity: '10', unitPrice: '500000' },
        { description: 'Mua tài liệu', quantity: '50', unitPrice: '25000', vatRate: 5 },
      ],
    });
    expect(contract).toMatchObject({
      amount: 13_000_000, // 10.000.000 + 1.000.000 VAT + 2.000.000
      incomeVatAmount: 1_000_000,
      incomeNetAmount: 12_000_000,
      costAmount: 6_312_500, // 5.000.000 + 1.250.000 + 62.500 VAT
      costVatAmount: 62_500,
      costNetAmount: 6_250_000,
      vatPayable: 937_500,
      profit: 5_750_000,
    });
    expect(contract.items.map((i) => [i.vatRate, i.amount, i.vatAmount, i.totalAmount])).toEqual([
      [10, 10_000_000, 1_000_000, 11_000_000],
      [null, 2_000_000, 0, 2_000_000],
    ]);
    const [teacherFee, material] = contract.costs;
    expect(material).toMatchObject({ vatRate: 5, amount: 1_250_000, vatAmount: 62_500, totalAmount: 1_312_500 });
    expect(sentTo('RECORD_REQUIRED')[0].message).toContain('cần thu, chi');

    const record = (flow: CashflowDirection, amount: number, costId?: number) =>
      service.recordEntry(U.T, contract.id, {
        flow,
        costId,
        date: '2026-10-30',
        amount,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      });
    await expect(record(CashflowDirection.OUT, 1)).rejects.toBeInstanceOf(BadRequestException);
    const other = await approved();
    await expect(
      record(CashflowDirection.OUT, 1, other.items[0].id),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(record(CashflowDirection.OUT, 1_312_501, material.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(record(CashflowDirection.IN, 13_000_001)).rejects.toBeInstanceOf(BadRequestException);

    notification.createNotifications.mockClear();
    const paid = await record(CashflowDirection.OUT, 1_312_500, material.id);
    expect(paid).toMatchObject({ flow: 'OUT', costId: material.id, orderId: null });
    expect(sentTo('RECORDED')[0].message).toContain('chi khoản "Mua tài liệu"');
    await record(CashflowDirection.IN, 13_000_000);
    let detail = await service.detail(U.A, contract.id);
    expect(detail).toMatchObject({
      status: OtherCashflowStatus.IN_PROGRESS, // còn thù lao giáo viên
      recordedAmount: 13_000_000,
      paidCostAmount: 1_312_500,
      remainingCostAmount: 5_000_000,
    });
    const teacherEntry = await record(CashflowDirection.OUT, 5_000_000, teacherFee.id);
    detail = await service.detail(U.A, contract.id);
    expect(detail.status).toBe(OtherCashflowStatus.COMPLETED);
    expect(detail.costs.map((c) => c.paidAmount)).toEqual([5_000_000, 1_312_500]);

    // Huỷ lần chi → khoản chi + tổng đã chi giảm, hợp đồng về đang thu/chi.
    const voided = await service.voidEntry(U.T, contract.id, teacherEntry.id, { reason: 'Sai TK' });
    expect(voided).toMatchObject({ status: OtherCashflowStatus.IN_PROGRESS, paidCostAmount: 1_312_500 });
    expect(voided.costs.find((c) => c.id === teacherFee.id)?.paidAmount).toBe(0);

    const rows = await ds.query<OtherCashflowEntryRow[]>(OTHER_CASHFLOW_ENTRIES_SQL);
    const lines = mapOtherCashflowEntries(rows).lines.filter(
      (l) => l.source.otherCashflowId === contract.id,
    );
    expect(lines.map((l) => [l.receipt, l.payment, l.description])).toEqual([
      [0n, 131_250_000n, 'Chi ngoài — Mua tài liệu — Liên kết dạy kỹ năng — Công ty Thử nghiệm'],
      [1_300_000_000n, 0n, 'Thu ngoài — Liên kết dạy kỹ năng — Công ty Thử nghiệm'],
    ]);
  });

  it('huỷ: người lập khi chờ duyệt; giám đốc khi đã duyệt mà chưa ghi nhận', async () => {
    const pending = await newContract();
    await expect(
      service.cancel(U.B, pending.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const cancelled = await service.cancel(U.A, pending.id, { reason: 'Không ký nữa' });
    expect(cancelled).toMatchObject({
      status: OtherCashflowStatus.CANCELLED,
      cancelReason: 'Không ký nữa',
    });

    const contract = await approved();
    await expect(
      service.cancel(U.A, contract.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    notification.createNotifications.mockClear();
    const byDirector = await service.cancel(U.D, contract.id, { reason: 'Đối tác rút' });
    expect(byDirector.status).toBe(OtherCashflowStatus.CANCELLED);
    expect(sentTo('CANCELLED')[0].receiverIds).toEqual([U.A.id]);
    await expect(
      service.recordEntry(U.T, contract.id, {
        flow: CashflowDirection.IN,
        date: '2026-10-29',
        amount: 1,
        cashAccountCode: '1111',
        idempotencyKey: idem(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const started = await approved();
    await service.recordEntry(U.T, started.id, {
      flow: CashflowDirection.IN,
      date: '2026-10-29',
      amount: 1,
      cashAccountCode: '1111',
      idempotencyKey: idem(),
    });
    await expect(
      service.cancel(U.D, started.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('tệp: người lập đính kèm hợp đồng, thủ quỹ đính kèm chứng từ; chỉ người xem được mới tải', async () => {
    const created = await newContract();
    await expect(
      service.uploadAttachments(U.A, created.id, [file('hop-dong.docx', DOCX_BYTES)], {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.uploadAttachments(U.A, created.id, [file('gia.pdf', PNG_BYTES)], {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.uploadAttachments(U.B, created.id, [file('hd.pdf', PDF_BYTES)], {}),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const withFile = await service.uploadAttachments(
      U.A,
      created.id,
      [file('Hợp đồng thuê sân.pdf', PDF_BYTES), file('trang2.png', PNG_BYTES)],
      {},
    );
    expect(withFile.attachments.map((a) => [a.kind, a.originalName])).toEqual([
      ['CONTRACT', 'Hợp đồng thuê sân.pdf'],
      ['CONTRACT', 'trang2.png'],
    ]);
    expect(withFile.attachments[0]).not.toHaveProperty('storagePath');
    const [pdf, png] = withFile.attachments;

    const { stream } = await service.attachmentFile(U.D, created.id, pdf.id);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(PDF_BYTES)).toBe(true);
    await expect(
      service.attachmentFile(U.B, created.id, pdf.id),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Trước khi duyệt người lập xoá được; sau khi duyệt thì không.
    const afterRemove = await service.removeAttachment(U.A, created.id, png.id);
    expect(afterRemove.attachments.map((a) => a.id)).toEqual([pdf.id]);
    await service.review(U.D, created.id, { decision: OtherCashflowStatus.APPROVED });
    await expect(
      service.removeAttachment(U.A, created.id, pdf.id),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const entry = await service.recordEntry(U.T, created.id, {
      flow: CashflowDirection.IN,
      date: '2026-10-30',
      amount: 1_000_000,
      cashAccountCode: '1111',
      idempotencyKey: idem(),
    });
    await expect(
      service.uploadAttachments(U.A, created.id, [file('ct.pdf', PDF_BYTES)], {
        entryId: entry.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const withEvidence = await service.uploadAttachments(
      U.T,
      created.id,
      [file('phieu-thu.pdf', PDF_BYTES)],
      { entryId: entry.id },
    );
    expect(
      withEvidence.attachments.find((a) => a.kind === 'EVIDENCE'),
    ).toMatchObject({ entryId: entry.id, originalName: 'phieu-thu.pdf', uploadedById: U.T.id });
  });

  describe('Hình thức Thương mại', () => {
    const ITEMS = [
      { itemCode: 'SGK-TH3', itemName: 'Sách Tin học 3', unit: 'quyển', quantity: '100', unitPrice: '35000' },
      { itemCode: 'BP-01', itemName: 'Bộ lắp ghép', unit: 'bộ', quantity: '2.5', unitPrice: '1000000' },
    ];
    const COSTS = [
      { description: 'Vận chuyển', payee: 'Nhà xe A', quantity: '1', unitPrice: '300000' },
      { description: 'Hoa hồng', quantity: '1', unitPrice: '200000' },
    ];

    async function commercial(extra: Record<string, unknown> = {}) {
      return service.create(U.A, {
        form: OtherCashflowForm.COMMERCIAL,
        title: 'Bán sách học kỳ I',
        documentNo: `DDH-${run}`,
        partnerName: 'Trường TH Thử nghiệm',
        items: ITEMS,
        costs: COSTS,
        ...extra,
      } as Parameters<OtherCashflowService['create']>[1]);
    }

    const execute = (orderId: number, contractId: number, extra: Record<string, unknown> = {}) =>
      service.executeOrder(U.T, contractId, orderId, {
        date: '2026-10-30',
        cashAccountCode: '1121',
        idempotencyKey: idem(),
        ...extra,
      });

    it('lập đơn: số tiền = tổng thành tiền khoản thu; khoản chi và lợi nhuận', async () => {
      await expect(commercial({ items: [], costs: [] })).rejects.toBeInstanceOf(BadRequestException);

      const created = await commercial();
      expect(created).toMatchObject({
        form: OtherCashflowForm.COMMERCIAL,
        documentNo: `DDH-${run}`,
        amount: 6_000_000,
        costAmount: 500_000,
        profit: 5_500_000,
        remainingCostAmount: 500_000,
      });
      expect(created.items.map((i) => [i.itemCode, i.quantity, i.amount])).toEqual([
        ['SGK-TH3', '100.0000', 3_500_000],
        ['BP-01', '2.5000', 2_500_000],
      ]);
      expect(
        created.costs.map((c) => [c.description, c.payee, c.amount, c.totalAmount, c.paidAmount]),
      ).toEqual([
        ['Vận chuyển', 'Nhà xe A', 300_000, 300_000, 0],
        ['Hoa hồng', null, 200_000, 200_000, 0],
      ]);

      // Sửa khi chờ duyệt: thay cả bộ dòng hàng; không gửi lại thì giữ nguyên.
      const edited = await service.update(U.A, created.id, {
        items: [{ ...ITEMS[0], quantity: '200' }],
      });
      expect(edited.amount).toBe(7_000_000);
      expect(edited.items).toHaveLength(1);
      expect(edited.costs).toHaveLength(2);
      const kept = await service.update(U.A, created.id, { title: 'Bán sách cả năm' });
      expect(kept).toMatchObject({ amount: 7_000_000, costAmount: 500_000 });
      // Đổi hình thức chỉ đổi luồng tiền, khoản thu/chi giữ nguyên.
      const standard = await service.update(U.A, created.id, {
        form: OtherCashflowForm.STANDARD,
        costs: [{ ...COSTS[0], vatRate: 8 }],
      });
      expect(standard).toMatchObject({
        form: OtherCashflowForm.STANDARD,
        amount: 7_000_000,
        costAmount: 324_000,
        costVatAmount: 24_000,
        profit: 6_700_000,
      });
      expect(standard.items).toHaveLength(1);
      expect(standard.costs).toHaveLength(1);
    });

    it('duyệt → báo kế toán công nợ; KT công nợ lập phiếu thu/lệnh chi; thủ quỹ thu/chi theo phiếu tới hoàn tất', async () => {
      const created = await commercial();
      notification.createNotifications.mockClear();
      await service.review(U.D, created.id, { decision: OtherCashflowStatus.APPROVED });
      expect(sentTo('DEBT_REQUIRED')[0].receiverIds).toEqual(
        expect.arrayContaining([U.C.id, U.K.id]),
      );
      expect(sentTo('DEBT_REQUIRED')[0].receiverIds).not.toContain(U.T.id);
      expect(sentTo('RECORD_REQUIRED')).toHaveLength(0);

      // Thủ quỹ không ghi nhận trực tiếp đơn Thương mại.
      await expect(
        service.recordEntry(U.T, created.id, {
          flow: CashflowDirection.IN,
          date: '2026-10-30',
          amount: 1,
          cashAccountCode: '1111',
          idempotencyKey: idem(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      const order = (kind: OrderKind, amount: number, costId?: number) =>
        service.createOrder(U.C, created.id, { kind, amount, costId });
      await expect(
        service.createOrder(U.T, created.id, { kind: OrderKind.RECEIPT, amount: 1 }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(order(OrderKind.RECEIPT, 6_000_001)).rejects.toBeInstanceOf(BadRequestException);
      await expect(order(OrderKind.PAYMENT, 1)).rejects.toBeInstanceOf(BadRequestException);

      notification.createNotifications.mockClear();
      let detail = await order(OrderKind.RECEIPT, 4_000_000);
      expect(sentTo('ORDER_CREATED')[0].receiverIds).toContain(U.T.id);
      // Phiếu đang chờ được trừ vào số còn có thể lập.
      await expect(order(OrderKind.RECEIPT, 2_000_001)).rejects.toBeInstanceOf(BadRequestException);
      const [shipping, commission] = detail.costs;
      await expect(order(OrderKind.PAYMENT, 300_001, shipping.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      detail = await order(OrderKind.PAYMENT, 300_000, shipping.id);
      const receipt1 = detail.orders.find((o) => o.kind === OrderKind.RECEIPT)!;
      const payShipping = detail.orders.find((o) => o.costId === shipping.id)!;
      expect(receipt1).toMatchObject({ status: OrderStatus.PENDING, createdById: U.C.id });

      // Lệnh chi trỏ chi phí của đơn khác → từ chối.
      const other = await commercial();
      await service.review(U.D, other.id, { decision: OtherCashflowStatus.APPROVED });
      await expect(
        service.createOrder(U.C, other.id, { kind: OrderKind.PAYMENT, amount: 1, costId: shipping.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Đơn đã có phiếu chờ → giám đốc không huỷ được.
      await service.createOrder(U.C, other.id, { kind: OrderKind.RECEIPT, amount: 1 });
      await expect(
        service.cancel(U.D, other.id, { reason: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Thủ quỹ thu theo phiếu: đúng số trên phiếu; bấm lặp không ghi hai lần.
      await expect(
        service.executeOrder(U.C, created.id, receipt1.id, {
          date: '2026-10-30',
          cashAccountCode: '1121',
          idempotencyKey: idem(),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const key = idem();
      notification.createNotifications.mockClear();
      const entry1 = await execute(receipt1.id, created.id, { idempotencyKey: key });
      expect(entry1).toMatchObject({ flow: 'IN', amount: 4_000_000, orderId: receipt1.id, costId: null });
      expect((await execute(receipt1.id, created.id, { idempotencyKey: key })).id).toBe(entry1.id);
      await expect(execute(receipt1.id, created.id)).rejects.toBeInstanceOf(ConflictException);
      expect(sentTo('ORDER_EXECUTED')[0].receiverIds).toEqual(
        expect.arrayContaining([U.A.id, U.C.id]),
      );

      const paid = await execute(payShipping.id, created.id, { cashAccountCode: '1111' });
      expect(paid).toMatchObject({ flow: 'OUT', amount: 300_000, costId: shipping.id });
      detail = await service.detail(U.A, created.id);
      expect(detail).toMatchObject({
        status: OtherCashflowStatus.IN_PROGRESS,
        recordedAmount: 4_000_000,
        paidCostAmount: 300_000,
        remainingAmount: 2_000_000,
        remainingCostAmount: 200_000,
      });
      expect(detail.costs.find((c) => c.id === shipping.id)?.paidAmount).toBe(300_000);

      // Huỷ lần thu → phiếu về "chờ", tiền hàng đã thu giảm; thu lại được.
      const voided = await service.voidEntry(U.T, created.id, entry1.id, { reason: 'Sai TK' });
      expect(voided.recordedAmount).toBe(0);
      expect(voided.orders.find((o) => o.id === receipt1.id)?.status).toBe(OrderStatus.PENDING);
      await execute(receipt1.id, created.id);

      // KT công nợ huỷ phiếu đang chờ (có lý do); phiếu đã huỷ không thu được.
      detail = await order(OrderKind.RECEIPT, 2_000_000);
      const receipt2 = detail.orders.filter((o) => o.kind === OrderKind.RECEIPT).at(-1)!;
      const afterCancel = await service.cancelOrder(U.C, created.id, receipt2.id, { reason: 'Lập nhầm' });
      expect(afterCancel.orders.find((o) => o.id === receipt2.id)).toMatchObject({
        status: OrderStatus.CANCELLED,
        cancelReason: 'Lập nhầm',
      });
      await expect(
        service.cancelOrder(U.C, created.id, receipt2.id, { reason: 'lại' }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(execute(receipt2.id, created.id)).rejects.toBeInstanceOf(ConflictException);

      // Thu nốt tiền hàng + chi nốt hoa hồng → hoàn tất; hết lập phiếu được.
      detail = await order(OrderKind.RECEIPT, 2_000_000);
      await execute(detail.orders.at(-1)!.id, created.id);
      detail = await service.detail(U.T, created.id);
      expect(detail.status).toBe(OtherCashflowStatus.IN_PROGRESS); // còn hoa hồng
      detail = await order(OrderKind.PAYMENT, 200_000, commission.id);
      await execute(detail.orders.at(-1)!.id, created.id, { cashAccountCode: '1111' });
      detail = await service.detail(U.C, created.id);
      expect(detail).toMatchObject({
        status: OtherCashflowStatus.COMPLETED,
        recordedAmount: 6_000_000,
        paidCostAmount: 500_000,
      });
      expect(detail.permissions.canCreateOrder).toBe(false);
      await expect(order(OrderKind.RECEIPT, 1)).rejects.toBeInstanceOf(BadRequestException);

      // Báo cáo thu chi: thu tiền hàng (bỏ lần đã huỷ) + chi từng khoản chi phí.
      const rows = await ds.query<OtherCashflowEntryRow[]>(OTHER_CASHFLOW_ENTRIES_SQL);
      const lines = mapOtherCashflowEntries(rows).lines.filter(
        (l) => l.source.otherCashflowId === created.id,
      );
      const total = (pick: (l: (typeof lines)[number]) => bigint) =>
        lines.reduce((sum, l) => sum + pick(l), 0n);
      expect(total((l) => l.receipt)).toBe(600_000_000n);
      expect(total((l) => l.payment)).toBe(50_000_000n);
      expect(lines.find((l) => l.partnerName === 'Nhà xe A')).toMatchObject({
        accountCode: '1111',
        payment: 30_000_000n,
      });
    });
  });
});
