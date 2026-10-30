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
  buildCommercialLines,
  parseContractCode,
  statusForProgress,
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
  it('trạng thái theo số đã thu/chi — đơn Thương mại cần đủ cả tiền hàng lẫn chi phí', () => {
    const p = (recordedAmount: number, paidCostAmount = 0, costAmount = 0) =>
      statusForProgress({ amount: 100, recordedAmount, costAmount, paidCostAmount });
    expect(p(0)).toBe(OtherCashflowStatus.APPROVED);
    expect(p(40)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(100)).toBe(OtherCashflowStatus.COMPLETED);
    expect(p(100, 0, 30)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(0, 10, 30)).toBe(OtherCashflowStatus.IN_PROGRESS);
    expect(p(100, 30, 30)).toBe(OtherCashflowStatus.COMPLETED);
  });

  it('đơn Thương mại: thành tiền = SL × đơn giá (làm tròn đồng), tổng tiền hàng và chi phí', () => {
    const built = buildCommercialLines(
      [
        { itemCode: 'SGK-01', itemName: 'Sách Tin học 3', unit: 'quyển', quantity: '120', unitPrice: '35500' },
        { itemCode: 'BUT', itemName: 'Bút', unit: '', quantity: '2.5', unitPrice: '1000.5' },
      ],
      [{ description: 'Vận chuyển', payee: 'Nhà xe A', amount: 300_000 }],
    );
    expect(built.items.map((i) => [i.lineNo, i.amount, i.unit])).toEqual([
      [1, 4_260_000, 'quyển'],
      [2, 2_501, null],
    ]);
    expect(built.amount).toBe(4_262_501);
    expect(built.costAmount).toBe(300_000);
    expect(built.costs[0]).toMatchObject({ lineNo: 1, paidAmount: 0, payee: 'Nhà xe A' });
    expect(() => buildCommercialLines([], [])).toThrow('ít nhất một dòng hàng');
    expect(() =>
      buildCommercialLines([{ itemCode: 'A', itemName: 'A', quantity: '0', unitPrice: '1' }], []),
    ).toThrow('số lượng phải lớn hơn 0');
    expect(() =>
      buildCommercialLines([{ itemCode: 'A', itemName: 'A', quantity: '1', unitPrice: '0' }], []),
    ).toThrow('Tổng tiền hàng phải lớn hơn 0');
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

  it('đơn Thương mại: thu tiền hàng ghi đối tác + trường; chi chi phí ghi người nhận chi phí', () => {
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
      description: 'Chi phí đơn thương mại — Vận chuyển — Cho thuê sân bóng',
      receipt: 0n,
      payment: 30_000_000n,
      partnerCode: null,
      partnerName: 'Nhà xe A',
    });
  });
});
