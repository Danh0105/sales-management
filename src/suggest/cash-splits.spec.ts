import {
  createCashSplitCursor,
  normalizeCashSplits,
  orderCashSplits,
  returnCashSplits,
} from './cash-splits';

describe('Nhiều nguồn chi khi Thủ quỹ xuất tiền', () => {
  it('một tài khoản (client cũ) = cả lệnh chi', () => {
    expect(normalizeCashSplits([], 5000000, '1111')).toEqual([
      { cashAccount: '1111', amount: 5000000 },
    ]);
  });

  it('tổng phải bằng đúng lệnh chi; không trùng; số tiền > 0', () => {
    expect(
      normalizeCashSplits(
        [
          { cashAccount: '1111', amount: 2000000 },
          { cashAccount: '1121', amount: '3000000' },
        ],
        5000000,
      ),
    ).toEqual([
      { cashAccount: '1111', amount: 2000000 },
      { cashAccount: '1121', amount: 3000000 },
    ]);
    expect(() =>
      normalizeCashSplits([{ cashAccount: '1111', amount: 1 }, { cashAccount: '1121', amount: 2 }], 4),
    ).toThrow(/phải bằng đúng lệnh chi/);
    expect(() =>
      normalizeCashSplits([{ cashAccount: '1111', amount: 2 }, { cashAccount: '1111', amount: 2 }], 4),
    ).toThrow(/trùng/);
    expect(() =>
      normalizeCashSplits([{ cashAccount: '1111', amount: 4 }, { cashAccount: '1121', amount: 0 }], 4),
    ).toThrow(/Nhập số tiền/);
    expect(() => normalizeCashSplits([{ cashAccount: '9999', amount: 4 }], 4)).toThrow(/không hợp lệ/);
  });

  it('lấy lần lượt: nguồn 1 hết thì sang nguồn 2, một khoản có thể 2 nguồn', () => {
    const cursor = createCashSplitCursor([
      { cashAccount: '1111', amount: 3000000 },
      { cashAccount: '1121', amount: 2000000 },
    ]);
    expect(cursor.take(2000000)).toEqual([{ cashAccount: '1111', amount: 2000000 }]);
    expect(cursor.take(2500000)).toEqual([
      { cashAccount: '1111', amount: 1000000 },
      { cashAccount: '1121', amount: 1500000 },
    ]);
    expect(cursor.take(500000)).toEqual([{ cashAccount: '1121', amount: 500000 }]);
    // Hết tiền các nguồn (bảng lệch) → phần thừa vào nguồn cuối.
    expect(cursor.take(100)).toEqual([{ cashAccount: '1121', amount: 100 }]);
  });

  it('phần dư trả về từ nguồn cuối', () => {
    const splits = [
      { cashAccount: '1111', amount: 3000000 },
      { cashAccount: '1121', amount: 2000000 },
    ];
    expect(returnCashSplits(splits, 1500000)).toEqual([{ cashAccount: '1121', amount: 1500000 }]);
    expect(returnCashSplits(splits, 2500000)).toEqual([
      { cashAccount: '1111', amount: 500000 },
      { cashAccount: '1121', amount: 2000000 },
    ]);
  });

  it('lệnh chi cũ một nguồn', () => {
    expect(orderCashSplits({ cashAccount: '1112', amount: '700.5', cashSplits: null })).toEqual([
      { cashAccount: '1112', amount: 700.5 },
    ]);
    expect(orderCashSplits({ cashAccount: null, amount: 1 })).toEqual([]);
  });
});
