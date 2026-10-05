import {
  formatSeriesCode,
  ORG_UNIT_CODES,
  POSITION_CODES,
  predictCodes,
} from './org-code';

describe('mã danh mục tổ chức do hệ thống sinh', () => {
  it('DV/CD + 4 số', () => {
    expect(formatSeriesCode(ORG_UNIT_CODES, 1)).toBe('DV0001');
    expect(formatSeriesCode(POSITION_CODES, 42)).toBe('CD0042');
    expect(formatSeriesCode(ORG_UNIT_CODES, 9999)).toBe('DV9999');
    expect(() => formatSeriesCode(ORG_UNIT_CODES, 0)).toThrow();
    expect(() => formatSeriesCode(ORG_UNIT_CODES, 10000)).toThrow();
  });

  it('dự đoán mã kế tiếp: theo trạng thái sequence, bỏ qua mã đã có', () => {
    // Sequence mới (chưa gọi nextval) → bắt đầu từ last_value.
    expect(
      predictCodes(
        ORG_UNIT_CODES,
        2,
        { lastValue: 1, isCalled: false },
        new Set(),
      ),
    ).toEqual(['DV0001', 'DV0002']);
    // Đã cấp tới 5; DV0006 tạo tay → bỏ qua.
    expect(
      predictCodes(
        ORG_UNIT_CODES,
        3,
        { lastValue: 5, isCalled: true },
        new Set(['DV0006']),
      ),
    ).toEqual(['DV0007', 'DV0008', 'DV0009']);
  });

  it('hết dải mã → báo lỗi', () => {
    expect(() =>
      predictCodes(
        POSITION_CODES,
        2,
        { lastValue: 9999, isCalled: false },
        new Set(),
      ),
    ).toThrow('Hết mã');
  });
});
