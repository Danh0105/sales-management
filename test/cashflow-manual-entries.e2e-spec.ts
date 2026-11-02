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
import { join } from 'path';
import { DataSource } from 'typeorm';

import { CashAccount } from '../src/cashflow-report/cash-account.entity';
import { CashManualEntry } from '../src/cashflow-report/cash-manual-entry.entity';
import { CashManualEntryService } from '../src/cashflow-report/cash-manual-entry.service';
import { CashflowReportService } from '../src/cashflow-report/cashflow-report.service';
import { AuthUser } from '../src/type/auth-user.type';

const DB = process.env.CASHFLOW_IT_DB;
const suite = DB ? describe : describe.skip;

jest.setTimeout(120_000);

suite('Tổng hợp thu chi — CRUD trên Postgres', () => {
  let moduleRef: TestingModule;
  let ds: DataSource;
  let report: CashflowReportService;
  let entries: CashManualEntryService;
  const stamp = String(Date.now() % 1_000_000_000).padStart(9, '0');
  const CASH = `1119${stamp}`;
  const BANK = `1129${stamp}`;
  const SPARE = `1128${stamp}`;
  const RANGE = { from: '2026-11-01', to: '2026-11-30' };
  const T: AuthUser = { id: -901, roles: ['thuquy'], name: 'Thủ quỹ IT' };
  const K: AuthUser = { id: -902, roles: ['ketoan_truong'], name: 'KTT IT' };

  beforeAll(async () => {
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
      providers: [CashflowReportService, CashManualEntryService],
    }).compile();
    ds = moduleRef.get(getDataSourceToken());
    report = moduleRef.get(CashflowReportService);
    entries = moduleRef.get(CashManualEntryService);
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
});
