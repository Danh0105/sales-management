import { ROLES_KEY } from '../auth/roles.decorator';
import {
  CashflowReportController,
  MANAGE_ROLES,
  REOPEN_ROLES,
} from './cashflow-report.controller';
import { mapManualEntries, ManualEntryRow } from './manual-entry-source';

const row = (extra: Partial<ManualEntryRow>): ManualEntryRow => ({
  id: 7,
  kind: 'IN',
  entry_date: '2026-11-02',
  account_code: '1111',
  counter_account_code: null,
  amount: '150000.00',
  document_no: null,
  description: 'Lãi tiền gửi',
  partner_name: 'Ngân hàng',
  ...extra,
});

describe('mapManualEntries', () => {
  it('Thu / Chi: một bút toán trên tài khoản đã chọn, số chứng từ tự sinh khi trống', () => {
    const { lines, issues } = mapManualEntries([
      row({}),
      row({ id: 8, kind: 'OUT', account_code: '1121', document_no: 'UNC-01' }),
    ]);
    expect(issues).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        key: 'MANUAL_ENTRY:7',
        documentNo: 'PT-7',
        accountCode: '1111',
        receipt: 15_000_000n,
        payment: 0n,
        isInternalTransfer: false,
        partnerName: 'Ngân hàng',
        source: { type: 'MANUAL_ENTRY', manualEntryId: 7 },
      }),
      expect.objectContaining({
        key: 'MANUAL_ENTRY:8',
        documentNo: 'UNC-01',
        accountCode: '1121',
        receipt: 0n,
        payment: 15_000_000n,
      }),
    ]);
  });

  it('Chuyển nội bộ: chi ở TK đi, thu ở TK nhận, cả hai đánh dấu nội bộ', () => {
    const { lines } = mapManualEntries([
      row({
        kind: 'TRANSFER',
        account_code: '1121',
        counter_account_code: '1111',
      }),
    ]);
    expect(
      lines.map((l) => [
        l.key,
        l.documentNo,
        l.accountCode,
        l.receipt,
        l.payment,
        l.isInternalTransfer,
      ]),
    ).toEqual([
      ['MANUAL_ENTRY:7:OUT', 'CK-7', '1121', 0n, 15_000_000n, true],
      ['MANUAL_ENTRY:7:IN', 'CK-7', '1111', 15_000_000n, 0n, true],
    ]);
  });

  it('bỏ qua số tiền không dương', () => {
    expect(mapManualEntries([row({ amount: '0.00' })]).lines).toEqual([]);
  });
});

describe('Quyền Tổng hợp thu chi', () => {
  const roles = (method: keyof CashflowReportController) =>
    Reflect.getMetadata(ROLES_KEY, CashflowReportController.prototype[method]);

  it('thủ quỹ và kế toán trưởng (cùng giám đốc) được thêm/sửa/xoá', () => {
    expect(MANAGE_ROLES).toEqual(
      expect.arrayContaining(['thuquy', 'ketoan_truong', 'director']),
    );
    for (const method of [
      'createAccount',
      'updateAccount',
      'deleteAccount',
      'getManualEntry',
      'createManualEntry',
      'updateManualEntry',
      'deleteManualEntry',
      'sourceDeletionPlan',
      'deleteSource',
      'dayClosingPreview',
      'closeDay',
    ] as const) {
      expect(roles(method)).toEqual(MANAGE_ROLES);
    }
  });

  it('chốt quỹ: thủ quỹ chốt được; chỉ kế toán trưởng / giám đốc mở lại', () => {
    expect(MANAGE_ROLES).toContain('thuquy');
    expect(REOPEN_ROLES).toEqual(['ketoan_truong', 'director']);
    expect(roles('reopenDay')).toEqual(REOPEN_ROLES);
    // Trạng thái / lịch sử chốt: quyền xem chung của báo cáo.
    expect(roles('dayClosingStatus')).toBeUndefined();
    expect(roles('dayClosings')).toBeUndefined();
  });

  it('kế toán, KT công nợ, trợ lý GĐ chỉ xem (không có trong quyền ghi)', () => {
    for (const role of ['accountant', 'ketoan_congno', 'troly_gd']) {
      expect(MANAGE_ROLES).not.toContain(role);
    }
    expect(roles('summary')).toBeUndefined(); // dùng quyền xem chung của controller
    expect(Reflect.getMetadata(ROLES_KEY, CashflowReportController)).toEqual(
      expect.arrayContaining(['thuquy', 'ketoan_truong', 'accountant']),
    );
  });
});
