import { parseMoney } from './utils/money';

describe('chuẩn hoá số tiền nhận từ client', () => {
    it('giữ nguyên số', () => {
        expect(parseMoney(500000)).toBe(500000);
        expect(parseMoney(0.5)).toBe(0.5);
    });

    it('chuỗi số thường', () => {
        expect(parseMoney('500000')).toBe(500000);
        expect(parseMoney('500000.50')).toBe(500000.5);
    });

    it('dấu chấm phân cách nghìn kiểu Việt Nam', () => {
        // Đây là ca đã âm thầm lưu 500 đồng thay vì 500.000 đồng.
        expect(parseMoney('500.000')).toBe(500000);
        expect(parseMoney('1.234.567')).toBe(1234567);
        expect(parseMoney('12.000')).toBe(12000);
    });

    it('dấu phẩy phân cách nghìn kiểu Anh', () => {
        expect(parseMoney('500,000')).toBe(500000);
        expect(parseMoney('1,234,567')).toBe(1234567);
    });

    it('bỏ khoảng trắng và ký hiệu tiền tệ', () => {
        expect(parseMoney(' 500.000 đ')).toBe(500000);
        expect(parseMoney('500000VND')).toBe(500000);
    });

    it('thiếu số tiền trả undefined, không phải NaN', () => {
        // Phân biệt "chưa nhập" với "nhập sai" để thông báo lỗi nói đúng việc.
        expect(parseMoney(undefined)).toBeUndefined();
        expect(parseMoney(null)).toBeUndefined();
        expect(parseMoney('')).toBeUndefined();
        expect(parseMoney('   ')).toBeUndefined();
    });

    it('chuỗi mập mờ trả NaN để tầng validate bắt, KHÔNG đoán bừa', () => {
        // "1.23" có thể là 1,23 hoặc 1230 — đoán sai là sai tiền, phải báo lỗi.
        expect(parseMoney('1.2345')).toBeNaN();
        expect(parseMoney('500.00.0')).toBeNaN();
        expect(parseMoney('abc')).toBeNaN();
        expect(parseMoney('500k')).toBeNaN();
        expect(parseMoney('-500')).toBeNaN();
        expect(parseMoney({})).toBeNaN();
        expect(parseMoney([])).toBeNaN();
    });

    it('số thập phân hai chữ số vẫn nhận — cột amount là numeric(15,2)', () => {
        expect(parseMoney('0.01')).toBe(0.01);
        expect(parseMoney('1.5')).toBe(1.5);
    });
});
