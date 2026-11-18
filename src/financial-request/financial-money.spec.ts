import { BadRequestException } from '@nestjs/common';

import {
  assertMoney,
  formatDecimal,
  formatVnd,
  lineAmount,
  parseDecimal,
  splitEvenly,
  sumMoney,
  vndToWords,
} from './financial-money';

describe('financial-money — tính tiền không dùng số thực', () => {
  it('thành tiền = SL × đơn giá, làm tròn nửa lên tới đồng', () => {
    expect(lineAmount('2', '150000')).toBe(300000);
    expect(lineAmount('1.5', '33333.33')).toBe(50000); // 49 999,995 → 50 000
    expect(lineAmount('0.3333', '3')).toBe(1); // 0,9999 → 1
    expect(lineAmount('3', '0.1')).toBe(0); // 0,3 → 0
    expect(lineAmount('1', '0.5')).toBe(1); // nửa → lên
    expect(lineAmount('0.1', '0.2')).toBe(0);
    expect(lineAmount(2.5, 1000)).toBe(2500);
  });

  it('không lệch như số thực: 0,1 × 3 lần cộng dồn', () => {
    // 0.1 + 0.2 trong JS = 0.30000000000000004 — ở đây cộng số nguyên VND.
    expect(
      sumMoney([lineAmount('0.1', '100000'), lineAmount('0.2', '100000')]),
    ).toBe(30000);
    expect(lineAmount('1.0005', '999999.99')).toBe(1000500);
  });

  it('từ chối quá số chữ số thập phân, số âm, chuỗi lạ', () => {
    expect(() => lineAmount('1.12345', '1')).toThrow(BadRequestException);
    expect(() => lineAmount('1', '1.123')).toThrow(BadRequestException);
    expect(() => lineAmount('-1', '1')).toThrow(BadRequestException);
    expect(() => lineAmount('abc', '1')).toThrow(BadRequestException);
    // Số 0 thừa sau phần cho phép vẫn hợp lệ.
    expect(lineAmount('1.50000', '2')).toBe(3);
  });

  it('chặn tràn số tiền', () => {
    expect(() => lineAmount('1000000', '9999999999999')).toThrow(
      BadRequestException,
    );
  });

  it('parse/format decimal giữ nguyên độ chính xác', () => {
    expect(parseDecimal('12.5', 4)).toBe(125000n);
    expect(formatDecimal(125000n, 4)).toBe('12.5000');
    expect(formatDecimal(5n, 2)).toBe('0.05');
  });

  it('assertMoney chỉ nhận số nguyên dương', () => {
    expect(assertMoney(1000, 'Số tiền')).toBe(1000);
    expect(() => assertMoney(10.5, 'Số tiền')).toThrow(BadRequestException);
    expect(() => assertMoney(0, 'Số tiền')).toThrow(BadRequestException);
    expect(assertMoney(0, 'Số tiền', { allowZero: true })).toBe(0);
  });

  it('chia đều kỳ khấu trừ, phần lẻ dồn kỳ cuối', () => {
    expect(splitEvenly(100, 3)).toEqual([33, 33, 34]);
    expect(splitEvenly(3_000_000, 2)).toEqual([1_500_000, 1_500_000]);
    expect(sumMoney(splitEvenly(1_000_001, 7))).toBe(1_000_001);
  });

  it('định dạng VND', () => {
    expect(formatVnd(1250000)).toBe('1.250.000');
    expect(formatVnd(-5000)).toBe('-5.000');
  });
});

describe('vndToWords — đọc số tiền bằng chữ', () => {
  const cases: [number, string][] = [
    [0, 'Không đồng'],
    [5, 'Năm đồng'],
    [15, 'Mười lăm đồng'],
    [21, 'Hai mươi mốt đồng'],
    [24, 'Hai mươi tư đồng'],
    [105, 'Một trăm linh năm đồng'],
    [1_000_000, 'Một triệu đồng'],
    [1_250_000, 'Một triệu hai trăm năm mươi nghìn đồng'],
    [1_000_015, 'Một triệu không trăm mười lăm đồng'],
    [
      12_345_678,
      'Mười hai triệu ba trăm bốn mươi lăm nghìn sáu trăm bảy mươi tám đồng',
    ],
    [2_000_000_000, 'Hai tỷ đồng'],
    [1_000_000_000_000, 'Một nghìn tỷ đồng'],
    [-50_000, 'Âm năm mươi nghìn đồng'],
  ];
  it.each(cases)('%d → %s', (amount, words) => {
    expect(vndToWords(amount)).toBe(words);
  });
});
