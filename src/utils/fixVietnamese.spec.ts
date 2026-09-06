import fixVietnamese from './fixVietnamese';

describe('fixVietnamese', () => {
    it('keeps correctly encoded Vietnamese text unchanged', () => {
        expect(fixVietnamese('Mai Thúy Thanh Phương')).toBe(
            'Mai Thúy Thanh Phương',
        );
        expect(fixVietnamese('Lê Thị Nhật Khanh')).toBe(
            'Lê Thị Nhật Khanh',
        );
    });

    it('repairs UTF-8 text that was decoded as latin1', () => {
        expect(fixVietnamese('Mai ThÃºy')).toBe('Mai Thúy');
    });

    it('keeps ASCII text unchanged', () => {
        expect(fixVietnamese('USER TEST')).toBe('USER TEST');
    });
});
