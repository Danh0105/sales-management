/**
 * Kiểm thử tích hợp Tổng hợp thu chi — thêm/sửa/xoá tài khoản và bút toán
 * nhập tay — trên Postgres THẬT.
 *
 * Chỉ chạy khi đặt `CASHFLOW_IT_DB` = tên một database test riêng có đủ bảng
 * nguồn của báo cáo và đã chạy migration 1795100000000. Guard trong test/setup
 * chặn mọi kết nối tới `sales_db`. Mỗi lần chạy dùng mã tài khoản riêng nên
 * chạy lại nhiều lần không đụng nhau. Không dùng dữ liệu thật.
 *
 *   CASHFLOW_IT_DB=sales_occ_test DB_USER=... DB_PASSWORD=... \
 *     npx jest --config ./test/jest-e2e.json test/cashflow-manual-entries.e2e-spec.ts
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DataSource } from 'typeorm';

import { CashAccount } from '../src/cashflow-report/cash-account.entity';
import { CashManualEntry } from '../src/cashflow-report/cash-manual-entry.entity';
import { CashManualEntryService } from '../src/cashflow-report/cash-manual-entry.service';
import { CashflowReportService } from '../src/cashflow-report/cashflow-report.service';
import { SourceDeletionService } from '../src/cashflow-report/source-deletion.service';
import { FinancialLedgerService } from '../src/financial-request/financial-ledger.service';
import { absolutePath } from '../src/financial-request/financial-storage';
import { contractCode } from '../src/other-cashflow/other-cashflow.constants';
import { AuthUser } from '../src/type/auth-user.type';

const DB = process.env.CASHFLOW_IT_DB;
const suite = DB ? describe : describe.skip;

jest.setTimeout(120_000);

suite('Tổng hợp thu chi — CRUD trên Postgres', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let report: CashflowReportService;
  let entries: CashManualEntryService;
  let deletion: SourceDeletionService;
  const workDir = mkdtempSync(join(tmpdir(), 'cashflow-it-'));
  const cwd = process.cwd();
  const stamp = String(Date.now() % 1_000_000_000).padStart(9, '0');
  const CASH = `1119${stamp}`;
  const BANK = `1129${stamp}`;
  const SPARE = `1128${stamp}`;
  const RANGE = { from: '2026-11-01', to: '2026-11-30' };
  const T: AuthUser = { id: -901, roles: ['thuquy'], name: 'Thủ quỹ IT' };
  const K: AuthUser = { id: -902, roles: ['ketoan_truong'], name: 'KTT IT' };

  beforeAll(async () => {
    process.env.FINANCIAL_STORAGE_DIR = join(workDir, 'storage');
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
        TypeOrmModule.forFeature([CashAccount, CashManualEntry]),
      ],
      providers: [
        CashflowReportService,
        CashManualEntryService,
        SourceDeletionService,
        // Chỉ nhánh Đề nghị tài chính dùng tới (test trong financial-requests.e2e-spec).
        { provide: FinancialLedgerService, useValue: {} },
      ],
    }).compile();
    ds = moduleRef.get(getDataSourceToken());
    report = moduleRef.get(CashflowReportService);
    entries = moduleRef.get(CashManualEntryService);
    deletion = moduleRef.get(SourceDeletionService);
  });

  afterAll(async () => {
    await ds?.query(
      `DELETE FROM cash_manual_entries WHERE account_code = ANY($1) OR counter_account_code = ANY($1)`,
      [[CASH, BANK, SPARE]],
    );
    await ds?.query(`DELETE FROM cash_accounts WHERE code = ANY($1)`, [
      [CASH, BANK, SPARE],
    ]);
    await moduleRef?.close();
    process.chdir(cwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('thêm / sửa tài khoản (thủ quỹ, kế toán trưởng)', async () => {
    const cash = await report.createAccount(
      { code: CASH, name: 'Quỹ thử IT', openingBalance: '500000', openingBalanceDate: '2026-11-01' },
      T,
    );
    expect(cash).toMatchObject({ code: CASH, groupCode: '111', isActive: true, openingBalanceUpdatedByName: 'Thủ quỹ IT' });
    const bank = await report.createAccount({ code: BANK, name: 'NH thử IT' }, K);
    expect(bank.groupCode).toBe('112');
    // Thứ tự mặc định: cuối nhóm.
    const [{ max }] = await ds.query(
      `SELECT max("sortOrder") AS max FROM cash_accounts WHERE "groupCode" = '112' AND code <> $1`,
      [BANK],
    );
    expect(bank.sortOrder).toBeGreaterThan(Number(max));
    await expect(report.createAccount({ code: CASH, name: 'Trùng' }, T)).rejects.toBeInstanceOf(ConflictException);
    await expect(
      report.createAccount({ code: SPARE, name: 'Thiếu ngày', openingBalance: '1000' }, T),
    ).rejects.toBeInstanceOf(BadRequestException);

    const renamed = await report.updateAccount(
      BANK,
      { name: 'NH thử IT (đổi tên)', sortOrder: 9999, openingBalance: '0', openingBalanceDate: '2026-11-01' },
      K,
    );
    expect(renamed).toMatchObject({ name: 'NH thử IT (đổi tên)', sortOrder: 9999, openingBalance: '0.00' });
  });

  let inId = 0;
  let outId = 0;
  let transferId = 0;

  it('thêm bút toán Thu / Chi / Chuyển nội bộ → vào sổ và số dư', async () => {
    inId = (await entries.create(
      { kind: 'IN', entryDate: '2026-11-03', accountCode: CASH, amount: '1000000', description: 'Nộp tiền bán tài liệu', partnerName: 'Khách lẻ' },
      T,
    )).id;
    const out = await entries.create(
      { kind: 'OUT', entryDate: '2026-11-04', accountCode: BANK, amount: '200000', description: 'Phí ngân hàng', documentNo: 'UNC-IT' },
      K,
    );
    outId = out.id;
    expect(out).toMatchObject({ displayDocumentNo: 'UNC-IT', createdByName: 'KTT IT', amount: '200000.00' });
    const transfer = await entries.create(
      { kind: 'TRANSFER', entryDate: '2026-11-05', accountCode: BANK, counterAccountCode: CASH, amount: '300000', description: 'Rút tiền về quỹ' },
      T,
    );
    transferId = transfer.id;
    expect(transfer.displayDocumentNo).toBe(`CK-${transferId}`);

    const cashLedger = await report.getLedger('111', { ...RANGE, accountCode: CASH });
    expect(cashLedger.accounts).toEqual([
      expect.objectContaining({ code: CASH, opening: '500000.00', receipts: '1300000.00', payments: '0.00', closing: '1800000.00' }),
    ]);
    expect(cashLedger.rows.map((r) => [r.documentNo, r.receipt, r.isInternalTransfer, r.source])).toEqual([
      [`PT-${inId}`, '1000000.00', false, { type: 'MANUAL_ENTRY', manualEntryId: inId }],
      [`CK-${transferId}`, '300000.00', true, { type: 'MANUAL_ENTRY', manualEntryId: transferId }],
    ]);
    const bankLedger = await report.getLedger('112', { ...RANGE, accountCode: BANK });
    expect(bankLedger.accounts[0]).toMatchObject({ payments: '500000.00', closing: '-500000.00' });

    // "Loại trừ chuyển tiền nội bộ" bỏ khoản chuyển khỏi tổng thu.
    expect((await report.getSummary({ ...RANGE, accountCode: CASH })).receipts).toBe('1300000.00');
    expect((await report.getSummary({ ...RANGE, accountCode: CASH, excludeInternal: true })).receipts).toBe('1000000.00');
  });

  it('kiểm tra dữ liệu bút toán', async () => {
    const base = { entryDate: '2026-11-06', amount: '1000', description: 'x' };
    await expect(entries.create({ ...base, kind: 'TRANSFER', accountCode: CASH }, T)).rejects.toThrow('tài khoản nhận');
    await expect(entries.create({ ...base, kind: 'TRANSFER', accountCode: CASH, counterAccountCode: CASH }, T)).rejects.toThrow('khác nhau');
    await expect(entries.create({ ...base, kind: 'IN', accountCode: '1119999999999' }, T)).rejects.toThrow('không có trong danh mục');
    await expect(entries.create({ ...base, kind: 'IN', accountCode: CASH, entryDate: '2026-02-30' }, T)).rejects.toThrow('Ngày hạch toán');
    await expect(entries.create({ ...base, kind: 'IN', accountCode: CASH, amount: '0' }, T)).rejects.toThrow('lớn hơn 0');

    // TK ngừng dùng: không chọn mới được, nhưng bút toán cũ vẫn sửa được nội dung.
    await report.updateAccount(BANK, { isActive: false }, K);
    await expect(entries.create({ ...base, kind: 'OUT', accountCode: BANK }, T)).rejects.toThrow('ngừng sử dụng');
    const edited = await entries.update(outId, { description: 'Phí quản lý tài khoản', amount: '250000' }, T);
    expect(edited).toMatchObject({ description: 'Phí quản lý tài khoản', amount: '250000.00', updatedByName: 'Thủ quỹ IT' });
    await report.updateAccount(BANK, { isActive: true }, K);
  });

  it('sửa loại bút toán và xoá (xoá mềm)', async () => {
    // Chuyển nội bộ → Chi: bỏ tài khoản nhận, khoản thu ở quỹ biến mất.
    const changed = await entries.update(transferId, { kind: 'OUT' }, T);
    expect(changed).toMatchObject({ kind: 'OUT', counterAccountCode: null, displayDocumentNo: `PC-${transferId}` });
    let cash = await report.getLedger('111', { ...RANGE, accountCode: CASH });
    expect(cash.accounts[0].receipts).toBe('1000000.00');

    await entries.remove(inId, T);
    await expect(entries.get(inId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(entries.update(inId, { amount: '1' }, T)).rejects.toBeInstanceOf(NotFoundException);
    cash = await report.getLedger('111', { ...RANGE, accountCode: CASH });
    expect(cash.rows).toHaveLength(0);
    expect(cash.accounts[0]).toMatchObject({ receipts: '0.00', closing: '500000.00' });
    const [row] = await ds.query(
      `SELECT deleted_at IS NOT NULL AS deleted, deleted_by_name FROM cash_manual_entries WHERE id = $1`,
      [inId],
    );
    expect(row).toEqual({ deleted: true, deleted_by_name: 'Thủ quỹ IT' });
  });

  it('xoá tài khoản: chỉ khi chưa có chứng từ và không thuộc danh mục cố định', async () => {
    await expect(report.deleteAccount('1111')).rejects.toThrow('Ngừng sử dụng');
    // CASH chỉ còn bút toán đã xoá mềm — vẫn tính là đã dùng.
    await expect(report.deleteAccount(CASH)).rejects.toThrow('đã có chứng từ');
    await report.createAccount({ code: SPARE, name: 'Tạo nhầm' }, T);
    expect(await report.deleteAccount(SPARE)).toEqual({ code: SPARE, deleted: true });
    await expect(report.deleteAccount(SPARE)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---- Xoá dòng trên sổ kèm dữ liệu gốc ----
  let employeeId = 0;
  let schoolId = 0;
  const ledgerOf = async (accountCode: string) =>
    (await report.getLedger(accountCode.startsWith('111') ? '111' : '112', { ...RANGE, accountCode })).accounts[0];
  const count = async (sql: string, params: unknown[]) =>
    Number((await ds.query(sql, params))[0].n);

  it('chuẩn bị nhân viên / trường thử', async () => {
    [{ id: employeeId }] = await ds.query(
      `INSERT INTO employee (name, phone, roles) VALUES ($1, $2, $3) RETURNING id`,
      [`Thủ quỹ xoá IT ${stamp}`, `07${stamp}`.slice(0, 20), ['thuquy']],
    );
    [{ id: schoolId }] = await ds.query(`SELECT id FROM schools ORDER BY id LIMIT 1`);
    expect(employeeId).toBeGreaterThan(0);
    expect(schoolId).toBeGreaterThan(0);
  });

  it('loại không hỗ trợ / bút toán nhập tay', async () => {
    await expect(deletion.plan('SALARY', 1)).rejects.toBeInstanceOf(BadRequestException);
    const entry = await entries.create(
      { kind: 'OUT', entryDate: '2026-11-20', accountCode: CASH, amount: '5000', description: 'Xoá từ sổ' },
      T,
    );
    const plan = await deletion.plan('MANUAL_ENTRY', entry.id);
    expect(plan).toMatchObject({ mode: 'DELETE', title: `Xoá bút toán PC-${entry.id}`, blockers: [] });
    await deletion.execute('MANUAL_ENTRY', entry.id, T);
    await expect(entries.get(entry.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('Đề xuất chi: xoá hẳn đề xuất + lệnh chi + lịch sử + tệp + thông báo; có phiếu kho thì chặn', async () => {
    const mainFile = `/uploads/suggest/it-${stamp}-main.txt`;
    const extraFile = `/uploads/suggest/it-${stamp}-extra.txt`;
    const [{ id }] = await ds.query(
      `INSERT INTO suggest (content, code, "createdBy", amount, "fileUrl") VALUES ('Mua văn phòng phẩm IT', $1, $2, 500000, $3) RETURNING id`,
      [`DXIT${stamp}`, employeeId, mainFile],
    );
    await ds.query(
      `INSERT INTO suggest_payment_order (code, "suggestId", amount, "paymentMethod", "createdBy", "cashAccount") VALUES ($1, $2, 500000, 'CASH', $3, $4)`,
      [`LCIT${stamp}`, id, employeeId, CASH],
    );
    await ds.query(
      `INSERT INTO suggest_history ("suggestId", action, data, "snapshotAt") VALUES ($1, 'CONFIRM_CASH_RELEASED', $2, '2026-11-15 09:00+07')`,
      [id, JSON.stringify({ cashAccount: CASH })],
    );
    await ds.query(
      `INSERT INTO suggest_attachment ("suggestId", "fileUrl", "fileName", "uploadedBy") VALUES ($1, $2, 'extra.txt', $3)`,
      [id, extraFile, employeeId],
    );
    await ds.query(
      `INSERT INTO notification (type, "receiverId", "entityId", message) VALUES ('SUGGEST', $1, $2, 'it')`,
      [employeeId, id],
    );
    // Tệp thật trong <cwd>/uploads/suggest — chạy trong thư mục tạm.
    process.chdir(workDir);
    mkdirSync(join(workDir, 'uploads', 'suggest'), { recursive: true });
    for (const url of [mainFile, extraFile]) writeFileSync(join(workDir, url), 'x');

    const before = await ledgerOf(CASH);
    const plan = await deletion.plan('EXPENSE_REQUEST', id);
    expect(plan).toMatchObject({ mode: 'DELETE', title: `Xoá đề xuất chi DXIT${stamp}`, blockers: [] });
    expect(plan.items.join('\n')).toContain(`Lệnh chi LCIT${stamp} (500.000 đ)`);
    expect(plan.items.join('\n')).toContain('1 lần xuất tiền / nhận lại quỹ');
    expect(plan.items.join('\n')).toContain('2 tệp đính kèm');

    await deletion.execute('EXPENSE_REQUEST', id, T);
    expect(await count(`SELECT count(*) AS n FROM suggest WHERE id = $1`, [id])).toBe(0);
    for (const table of ['suggest_payment_order', 'suggest_history', 'suggest_attachment']) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE "suggestId" = $1`, [id])).toBe(0);
    }
    expect(await count(`SELECT count(*) AS n FROM notification WHERE type = 'SUGGEST' AND "entityId" = $1`, [id])).toBe(0);
    expect(existsSync(join(workDir, mainFile)) || existsSync(join(workDir, extraFile))).toBe(false);
    expect(Number((await ledgerOf(CASH)).payments)).toBe(Number(before.payments) - 500000);
    process.chdir(cwd);

    const [{ id: stocked }] = await ds.query(
      `INSERT INTO suggest (content, code, "createdBy") VALUES ('Xin thiết bị IT', $1, $2) RETURNING id`,
      [`DXKIT${stamp}`, employeeId],
    );
    await ds.query(
      `INSERT INTO warehouse_receipt (code, type, items, "createdBy", "relatedSuggestId") VALUES ($1, 'OUT', '[]', $2, $3)`,
      [`PXIT${stamp}`, employeeId, stocked],
    );
    expect((await deletion.plan('EXPENSE_REQUEST', stocked)).blockers).toHaveLength(1);
    await expect(deletion.execute('EXPENSE_REQUEST', stocked, T)).rejects.toThrow('phiếu xuất/nhập kho');
    await ds.query(`DELETE FROM warehouse_receipt WHERE "relatedSuggestId" = $1`, [stocked]);
    await ds.query(`DELETE FROM suggest WHERE id = $1`, [stocked]);
  });

  it('Thu Chi ngoài: xoá hẳn hợp đồng + lần thu/chi + nhật ký + tệp + thông báo', async () => {
    const [{ id }] = await ds.query(
      `INSERT INTO other_cashflow_contracts (direction, title, partner_name, amount, created_by_id, submitted_at, status, recorded_amount)
       VALUES ('IN', 'Cho thuê sân IT', 'Đối tác IT', 3000000, $1, now(), 'IN_PROGRESS', 1000000) RETURNING id`,
      [employeeId],
    );
    const [{ id: entryId }] = await ds.query(
      `INSERT INTO other_cashflow_entries (contract_id, flow, entry_date, amount, cash_account_code, idempotency_key, recorded_by_id)
       VALUES ($1, 'IN', '2026-11-16', 1000000, $2, $3, $4) RETURNING id`,
      [id, CASH, `occ-del-${stamp}`, employeeId],
    );
    await ds.query(`INSERT INTO other_cashflow_events (contract_id, action) VALUES ($1, 'CREATED')`, [id]);
    const storagePath = `other-cashflow/${id}/it-${stamp}.pdf`;
    await ds.query(
      `INSERT INTO other_cashflow_attachments (contract_id, entry_id, kind, storage_path, original_name, mime_type, size_bytes, sha256, uploaded_by_id)
       VALUES ($1, $2, 'EVIDENCE', $3, 'bien-nhan.pdf', 'application/pdf', 1, 'x', $4)`,
      [id, entryId, storagePath, employeeId],
    );
    mkdirSync(dirname(absolutePath(storagePath)), { recursive: true });
    writeFileSync(absolutePath(storagePath), 'x');
    await ds.query(
      `INSERT INTO notification (type, "receiverId", message, meta) VALUES ('POLICY', $1, 'it', $2)`,
      [employeeId, JSON.stringify({ kind: 'other_cashflow', contractId: id })],
    );

    const before = await ledgerOf(CASH);
    const plan = await deletion.plan('OTHER_CASHFLOW', id);
    expect(plan.title).toBe(`Xoá hợp đồng Thu Chi ngoài ${contractCode(id)}`);
    expect(plan.items.join('\n')).toContain('1 lần thu/chi (1.000.000 đ)');
    await deletion.execute('OTHER_CASHFLOW', id, T);
    for (const table of ['other_cashflow_entries', 'other_cashflow_events', 'other_cashflow_attachments']) {
      expect(await count(`SELECT count(*) AS n FROM ${table} WHERE contract_id = $1`, [id])).toBe(0);
    }
    expect(await count(`SELECT count(*) AS n FROM other_cashflow_contracts WHERE id = $1`, [id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM notification WHERE meta->>'contractId' = $1`, [String(id)])).toBe(0);
    expect(existsSync(absolutePath(storagePath))).toBe(false);
    expect(Number((await ledgerOf(CASH)).receipts)).toBe(Number(before.receipts) - 1000000);
  });

  it('Hóa Đơn / Chi Trường / Chi Ngoài: chỉ gỡ khoản thu chi khỏi sổ, giữ dữ liệu của trường', async () => {
    const year = 2100 + (Number(stamp) % 800);
    const [{ id: periodId }] = await ds.query(
      `INSERT INTO expense_periods (school_id, month, year) VALUES ($1, 11, $2) RETURNING id`,
      [schoolId, year],
    );
    const [{ id: sheetId }] = await ds.query(
      `INSERT INTO school_expenses (period_id, school_id) VALUES ($1, $2) RETURNING id`,
      [periodId, schoolId],
    );
    try {
      const [{ id: revenueId }] = await ds.query(
        `INSERT INTO revenue_items (school_expense_id, "rowIndex", content, "invoiceAmount", "paidAmount",
           "invoiceCashDirection", "invoiceCashAmount", "invoiceCashAccount", "invoicePaymentDate")
         VALUES ($1, 0, 'Học phí IT', 750000, 750000, 'IN', 750000, $2, '2026-11-12') RETURNING id`,
        [sheetId, CASH],
      );
      const [{ id: schoolItemId }] = await ds.query(
        `INSERT INTO school_expense_items (school_expense_id, "rowIndex", "schoolExpenseAmount", "paidAmount", remaining, "expenseDate", "cashAccount")
         VALUES ($1, 0, 500000, 300000, 200000, '2026-11-13', $2) RETURNING id`,
        [sheetId, CASH],
      );
      const [{ id: mgmtItemId }] = await ds.query(
        `INSERT INTO management_expense_items (school_expense_id, "rowIndex", "totalOutside", "paidAmount", remaining, "expenseDate", "cashAccount")
         VALUES ($1, 0, 400000, 100000, 300000, '2026-11-14', $2) RETURNING id`,
        [sheetId, CASH],
      );
      const ledgerRows = (await report.getLedger('111', { ...RANGE, accountCode: CASH, limit: 500 })).rows;
      expect(ledgerRows.find((r) => r.source.type === 'INVOICE' && r.source.itemId === revenueId)).toBeDefined();
      const before = await ledgerOf(CASH);

      const plan = await deletion.plan('SCHOOL_EXPENSE', schoolItemId);
      expect(plan).toMatchObject({ mode: 'UNPOST', blockers: [] });
      expect(plan.items[1]).toBe(`Bỏ khoản chi 300.000 đ · tài khoản ${CASH} · ngày 13/11/2026`);

      await deletion.execute('INVOICE', revenueId, T);
      await deletion.execute('SCHOOL_EXPENSE', schoolItemId, T);
      await deletion.execute('MANAGEMENT_EXPENSE', mgmtItemId, T);

      const [revenue] = await ds.query(
        `SELECT "invoiceAmount"::int AS invoice, "paidAmount"::int AS paid, "invoiceCashDirection" AS dir, "invoiceCashAmount" AS amt,
           "invoiceCashAccount" AS acc, "invoicePaymentDate" AS dt, content FROM revenue_items WHERE id = $1`,
        [revenueId],
      );
      expect(revenue).toEqual({ invoice: 750000, paid: 750000, dir: null, amt: null, acc: null, dt: null, content: 'Học phí IT' });
      for (const [table, itemId, base] of [
        ['school_expense_items', schoolItemId, 500000],
        ['management_expense_items', mgmtItemId, 400000],
      ] as const) {
        const [item] = await ds.query(
          `SELECT "paidAmount"::int AS paid, remaining::int AS remaining, "expenseDate" AS dt, "cashAccount" AS acc FROM ${table} WHERE id = $1`,
          [itemId],
        );
        expect(item).toEqual({ paid: 0, remaining: base, dt: null, acc: null });
      }
      const after = await ledgerOf(CASH);
      expect(Number(after.receipts)).toBe(Number(before.receipts) - 750000);
      expect(Number(after.payments)).toBe(Number(before.payments) - 400000);
      // Gỡ lần hai: không còn gì trên sổ.
      await expect(deletion.execute('SCHOOL_EXPENSE', schoolItemId, T)).rejects.toThrow('không còn khoản thu chi');
    } finally {
      for (const table of ['revenue_items', 'school_expense_items', 'management_expense_items']) {
        await ds.query(`DELETE FROM ${table} WHERE school_expense_id = $1`, [sheetId]);
      }
      await ds.query(`DELETE FROM school_expenses WHERE id = $1`, [sheetId]);
      await ds.query(`DELETE FROM expense_periods WHERE id = $1`, [periodId]);
    }
  });
});
