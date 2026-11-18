import { mapOtherCashflowEntries } from '../cashflow-report/other-cashflow-source';
import { AuthUser } from '../type/auth-user.type';
import { OtherCashflowContract } from './entities/other-cashflow-contract.entity';
import {
  canCancel,
  canCreateOrder,
  canEdit,
  canExecuteOrder,
  canRecordEntry,
  canReview,
  canUploadContractFile,
  canUseModule,
  canView,
  permissionsOf,
} from './other-cashflow-access';
import {
  CashflowDirection,
  contractCode,
  OtherCashflowForm,
  OtherCashflowStatus,
} from './other-cashflow.constants';
import {
  buildLines,
  parseContractCode,
  profitOf,
  statusForProgress,
  vatOf,
} from './other-cashflow.service';

const sales: AuthUser = { id: 10, roles: ['sales'] };
const otherSales: AuthUser = { id: 11, roles: ['employee'] };
const director: AuthUser = { id: 1, roles: ['director'] };
const cashier: AuthUser = { id: 2, roles: ['thuquy'] };
const chiefAccountant: AuthUser = { id: 3, roles: ['ketoan_truong'] };
const debtAccountant: AuthUser = { id: 5, roles: ['ketoan_congno'] };
const assistant: AuthUser = { id: 6, roles: ['troly_gd'] };
const teacher: AuthUser = { id: 4, roles: ['giaovien_ctv'] };

function contract(
  status: OtherCashflowStatus,
  extra: Partial<OtherCashflowContract> = {},
): OtherCashflowContract {
  return {
    id: 7,
    createdById: sales.id,
    status,
    form: OtherCashflowForm.STANDARD,
    amount: 1_000_000,
    recordedAmount: 0,
    costAmount: 0,
    paidCostAmount: 0,
    ...extra,
  } as OtherCashflowContract;
}

describe('Thu Chi ngoài — quyền', () => {
  it('chỉ NV kinh doanh và các vai trò xem-tất-cả vào được phân hệ', () => {
    expect(canUseModule(sales)).toBe(true);
    expect(canUseModule(director)).toBe(true);
    expect(canUseModule(cashier)).toBe(true);
    expect(canUseModule(chiefAccountant)).toBe(true);
    expect(canUseModule(teacher)).toBe(false);
  });

  it('NV kinh doanh chỉ xem hợp đồng mình lập', () => {
    const c = contract(OtherCashflowStatus.PENDING);
    expect(canView(sales, c)).toBe(true);
    expect(canView(otherSales, c)).toBe(false);
    expect(canView(director, c)).toBe(true);
    expect(canView(cashier, c)).toBe(true);
  });

  it('người lập sửa được khi chờ duyệt / bị từ chối, không sửa sau khi duyệt', () => {
    expect(canEdit(sales, contract(OtherCashflowStatus.PENDING))).toBe(true);
    expect(canEdit(sales, contract(OtherCashflowStatus.REJECTED))).toBe(true);
    expect(canEdit(sales, contract(OtherCashflowStatus.APPROVED))).toBe(false);
    expect(canEdit(otherSales, contract(OtherCashflowStatus.PENDING))).toBe(false);
    expect(canEdit(director, contract(OtherCashflowStatus.PENDING))).toBe(false);
  });

  it('chỉ giám đốc duyệt, và chỉ khi đang chờ duyệt', () => {
    expect(canReview(director, contract(OtherCashflowStatus.PENDING))).toBe(true);
    expect(canReview(director, contract(OtherCashflowStatus.REJECTED))).toBe(false);
    expect(canReview(cashier, contract(OtherCashflowStatus.PENDING))).toBe(false);
    expect(canReview(sales, contract(OtherCashflowStatus.PENDING))).toBe(false);
  });

  it('chỉ thủ quỹ ghi nhận, khi đã duyệt và chưa đủ', () => {
    expect(canRecordEntry(cashier, contract(OtherCashflowStatus.APPROVED))).toBe(true);
    expect(canRecordEntry(cashier, contract(OtherCashflowStatus.IN_PROGRESS))).toBe(true);
    expect(canRecordEntry(cashier, contract(OtherCashflowStatus.PENDING))).toBe(false);
    expect(canRecordEntry(cashier, contract(OtherCashflowStatus.COMPLETED))).toBe(false);
    expect(canRecordEntry(director, contract(OtherCashflowStatus.APPROVED))).toBe(false);
    // Kế toán trưởng có toàn quyền thủ quỹ — như luồng Đề xuất chi.
    expect(canRecordEntry(chiefAccountant, contract(OtherCashflowStatus.APPROVED))).toBe(true);
    expect(canRecordEntry(debtAccountant, contract(OtherCashflowStatus.APPROVED))).toBe(false);
  });

  it('đơn Thương mại: KT công nợ lập phiếu, thủ quỹ thu/chi theo phiếu, không ghi nhận trực tiếp', () => {
    const order = contract(OtherCashflowStatus.APPROVED, { form: OtherCashflowForm.COMMERCIAL });
    expect(canRecordEntry(cashier, order)).toBe(false);
    expect(canCreateOrder(debtAccountant, order)).toBe(true);
    expect(canCreateOrder(chiefAccountant, order)).toBe(true);
    expect(canCreateOrder(cashier, order)).toBe(false);
    expect(canCreateOrder(director, order)).toBe(false);
    expect(canCreateOrder(debtAccountant, contract(OtherCashflowStatus.APPROVED))).toBe(false);
    expect(
      canCreateOrder(debtAccountant, { ...order, status: OtherCashflowStatus.PENDING } as OtherCashflowContract),
    ).toBe(false);
    expect(canExecuteOrder(cashier, order)).toBe(true);
    expect(canExecuteOrder(debtAccountant, order)).toBe(false);
    expect(canView(debtAccountant, order)).toBe(true);
  });

  it('huỷ: người lập trước khi duyệt; giám đốc khi đã duyệt mà chưa thu/chi đồng nào', () => {
    expect(canCancel(sales, contract(OtherCashflowStatus.REJECTED))).toBe(true);
    expect(canCancel(sales, contract(OtherCashflowStatus.APPROVED))).toBe(false);
    expect(canCancel(director, contract(OtherCashflowStatus.APPROVED))).toBe(true);
    expect(
      canCancel(
        director,
        contract(OtherCashflowStatus.IN_PROGRESS, { recordedAmount: 1 }),
      ),
    ).toBe(false);
    expect(canCancel(cashier, contract(OtherCashflowStatus.APPROVED))).toBe(false);
    expect(
      canCancel(
        director,
        contract(OtherCashflowStatus.APPROVED, { form: OtherCashflowForm.COMMERCIAL, paidCostAmount: 1 }),
      ),
    ).toBe(false);
  });

  it('tệp hợp đồng: người lập, trừ khi đã huỷ/hoàn tất', () => {
    expect(canUploadContractFile(sales, contract(OtherCashflowStatus.APPROVED))).toBe(true);
    expect(canUploadContractFile(sales, contract(OtherCashflowStatus.COMPLETED))).toBe(false);
    expect(canUploadContractFile(sales, contract(OtherCashflowStatus.CANCELLED))).toBe(false);
    expect(canUploadContractFile(cashier, contract(OtherCashflowStatus.APPROVED))).toBe(false);
  });

  it('trợ lý GĐ chỉ xem — không có thao tác nào', () => {
    for (const status of Object.values(OtherCashflowStatus)) {
      const perms = permissionsOf(assistant, contract(status, { form: OtherCashflowForm.COMMERCIAL }));
      expect(Object.values(perms).every((value) => value === false)).toBe(true);
    }
  });
});

describe('Thu Chi ngoài — tiện ích', () => {
  it('trạng thái theo số đã thu/chi — cần đủ cả tổng phải thu lẫn các khoản chi', () => {
    const p = (recordedAmount: number, paidCostAmount = 0, costAmount = 0) =>
      statusForProgress({ amount: 100, recordedAmount, costAmount, paidCostAmount });
    expect(p(0)).toBe(OtherCashflowStatus.APPROVED);
    expect(p(40)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(100)).toBe(OtherCashflowStatus.COMPLETED);
    expect(p(100, 0, 30)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(0, 10, 30)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(100, 30, 30)).toBe(OtherCashflowStatus.COMPLETED);
    // Hợp đồng chỉ có khoản chi.
    const onlyCosts = (paidCostAmount: number) =>
      statusForProgress({ amount: 0, recordedAmount: 0, costAmount: 30, paidCostAmount });
    expect(onlyCosts(0)).toBe(OtherCashflowStatus.APPROVED);
    expect(onlyCosts(10)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(onlyCosts(30)).toBe(OtherCashflowStatus.COMPLETED);
  });

  it('thuế VAT làm tròn nửa lên tới đồng; không thuế = 0', () => {
    expect(vatOf(10_000_000, 10)).toBe(1_000_000);
    expect(vatOf(2_501, 8)).toBe(200); // 200,08
    expect(vatOf(2_506, 10)).toBe(251); // 250,6
    expect(vatOf(2_505, 10)).toBe(251); // 250,5 → lên
    expect(vatOf(1_000, 0)).toBe(0);
    expect(vatOf(1_000, null)).toBe(0);
  });

  it('khoản thu + khoản chi: thành tiền = SL × đơn giá, cộng thuế từng khoản; lợi nhuận không tính VAT', () => {
    const built = buildLines(
      [
        { itemCode: 'SGK-01', itemName: 'Sách Tin học 3', unit: 'quyển', quantity: '120', unitPrice: '35500', vatRate: 5 },
        { itemName: 'Phí đào tạo', quantity: '1', unitPrice: '2000000' },
        { itemCode: '', itemName: 'Bút', unit: '', quantity: '2.5', unitPrice: '1000.5', vatRate: 0 },
      ],
      [
        { description: 'Mua sách NXB', payee: 'NXB GD', quantity: '120', unitPrice: '25000', vatRate: 5 },
        { description: 'Vận chuyển', payee: '', quantity: '1', unitPrice: '300000' },
      ],
    );
    expect(
      built.items.map((i) => [i.lineNo, i.itemCode, i.amount, i.vatRate, i.vatAmount, i.totalAmount, i.unit]),
    ).toEqual([
      [1, 'SGK-01', 4_260_000, 5, 213_000, 4_473_000, 'quyển'],
      [2, null, 2_000_000, null, 0, 2_000_000, null],
      [3, null, 2_501, 0, 0, 2_501, null],
    ]);
    expect(built.costs.map((c) => [c.lineNo, c.amount, c.vatAmount, c.totalAmount, c.payee, c.paidAmount])).toEqual([
      [1, 3_000_000, 150_000, 3_150_000, 'NXB GD', 0],
      [2, 300_000, 0, 300_000, null, 0],
    ]);
    expect(built).toMatchObject({
      amount: 6_475_501,
      incomeVatAmount: 213_000,
      costAmount: 3_450_000,
      costVatAmount: 150_000,
    });
    // (6.475.501 − 213.000) − (3.450.000 − 150.000)
    expect(profitOf(built)).toBe(2_962_501);
  });

  it('cần ít nhất một khoản; chỉ có khoản chi cũng được; khoản chi phải > 0', () => {
    expect(() => buildLines([], [])).toThrow('ít nhất một khoản thu hoặc khoản chi');
    const onlyCosts = buildLines([], [{ description: 'Thuê xe', quantity: '2', unitPrice: '500000', vatRate: 8 }]);
    expect(onlyCosts).toMatchObject({ amount: 0, costAmount: 1_080_000, costVatAmount: 80_000 });
    expect(profitOf(onlyCosts)).toBe(-1_000_000);
    expect(() => buildLines([{ itemName: 'A', quantity: '0', unitPrice: '1' }], [])).toThrow(
      'Khoản thu 1: số lượng phải lớn hơn 0',
    );
    expect(() => buildLines([], [{ description: 'A', quantity: '1', unitPrice: '0' }])).toThrow(
      'Khoản chi 1: số tiền phải lớn hơn 0',
    );
    expect(() => buildLines([{ itemName: 'A', quantity: '1', unitPrice: '0' }], [])).toThrow(
      'Tổng tiền hợp đồng phải lớn hơn 0',
    );
  });

  it('mã hợp đồng', () => {
    expect(contractCode(12)).toBe('TCN-00012');
    expect(parseContractCode('TCN-00012')).toBe(12);
    expect(parseContractCode('tcn12')).toBe(12);
    expect(parseContractCode(' 12 ')).toBe(12);
    expect(parseContractCode('Công ty A')).toBeNull();
  });
});

describe('Thu Chi ngoài — bút toán báo cáo thu chi', () => {
  const base = {
    contract_id: 5,
    form: 'STANDARD',
    title: 'Cho thuê  sân\nbóng',
    partner_name: 'Công ty A',
    school_id: null,
    cost_description: null,
    cost_payee: null,
    entry_date: '2026-10-30',
    cash_account_code: '1111',
  };

  it('hợp đồng Thu → bút toán thu, Chi → bút toán chi, theo tài khoản của lần ghi nhận', () => {
    const { lines, issues } = mapOtherCashflowEntries([
      { ...base, entry_id: 1, flow: CashflowDirection.IN, amount: '1500000' },
      {
        ...base,
        entry_id: 2,
        flow: CashflowDirection.OUT,
        amount: '200000',
        school_id: 9,
        cash_account_code: '1121',
      },
    ]);
    expect(issues).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      key: 'OTHER_CASHFLOW:1',
      postingDate: '2026-10-30',
      documentNo: 'TCN-00005',
      description: 'Thu ngoài — Cho thuê sân bóng — Công ty A',
      accountCode: '1111',
      receipt: 150_000_000n,
      payment: 0n,
      partnerCode: null,
      partnerName: 'Công ty A',
      source: { type: 'OTHER_CASHFLOW', otherCashflowId: 5 },
    });
    expect(lines[1]).toMatchObject({
      key: 'OTHER_CASHFLOW:2',
      accountCode: '1121',
      receipt: 0n,
      payment: 20_000_000n,
      partnerCode: 'TR9',
    });
  });

  it('thu ghi đối tác + trường; chi một khoản ghi người nhận của khoản (không có thì đối tác)', () => {
    const { lines } = mapOtherCashflowEntries([
      { ...base, entry_id: 3, form: 'COMMERCIAL', school_id: 9, flow: CashflowDirection.IN, amount: '4000000' },
      {
        ...base,
        entry_id: 4,
        form: 'COMMERCIAL',
        school_id: 9,
        flow: CashflowDirection.OUT,
        amount: '300000',
        cost_description: 'Vận chuyển',
        cost_payee: 'Nhà xe A',
      },
    ]);
    expect(lines[0]).toMatchObject({
      description: 'Thu ngoài (thương mại) — Cho thuê sân bóng — Công ty A',
      receipt: 400_000_000n,
      partnerCode: 'TR9',
      partnerName: 'Công ty A',
    });
    expect(lines[1]).toMatchObject({
      description: 'Chi ngoài (thương mại) — Vận chuyển — Cho thuê sân bóng — Nhà xe A',
      receipt: 0n,
      payment: 30_000_000n,
      partnerCode: null,
      partnerName: 'Nhà xe A',
    });
  });

  it('khoản chi không có người nhận → đối tác + trường; HĐ Chi cũ (khoản trùng tên hợp đồng) giữ diễn giải cũ', () => {
    const { lines } = mapOtherCashflowEntries([
      {
        ...base,
        entry_id: 5,
        school_id: 9,
        flow: CashflowDirection.OUT,
        amount: '100000',
        cost_description: 'Thuê xe',
      },
      {
        ...base,
        entry_id: 6,
        school_id: 9,
        flow: CashflowDirection.OUT,
        amount: '100000',
        cost_description: base.title,
      },
    ]);
    expect(lines[0]).toMatchObject({
      description: 'Chi ngoài — Thuê xe — Cho thuê sân bóng — Công ty A',
      partnerCode: 'TR9',
      partnerName: 'Công ty A',
    });
    expect(lines[1]).toMatchObject({
      description: 'Chi ngoài — Cho thuê sân bóng — Công ty A',
      partnerCode: 'TR9',
      partnerName: 'Công ty A',
    });
  });
});
