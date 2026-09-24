/** Ngày hiện tại theo giờ Việt Nam, dạng YYYY-MM-DD */
export function vnToday(date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/** YYYYMM theo giờ Việt Nam — dùng sinh mã DX-/LC- */
export function vnYearMonth(date = new Date()): string {
    return vnToday(date).slice(0, 7).replace('-', '');
}

/** Số ngày chênh lệch (dateA - dateB), input dạng YYYY-MM-DD */
export function diffDays(dateA: string, dateB: string): number {
    const a = new Date(`${dateA}T00:00:00Z`).getTime();
    const b = new Date(`${dateB}T00:00:00Z`).getTime();

    return Math.round((a - b) / 86_400_000);
}

/**
 * Năm học hiện tại theo giờ Việt Nam, dạng "YYYY-YYYY" — năm học bắt đầu từ
 * tháng 8 (VD: tháng 8/2026 → tháng 7/2027 là năm học "2026-2027"). Dùng để
 * tự điền năm học cho đề xuất chi, người tạo không cần tự chọn.
 */
export function currentSchoolYear(date = new Date()): string {
    const [year, month] = vnToday(date).split('-').map(Number);
    return month >= 8 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

/** Kiểm tra chuỗi năm học dạng "YYYY-YYYY", năm sau phải liền sau năm trước. */
export function isValidSchoolYear(schoolYear: string): boolean {
    const match = /^(\d{4})-(\d{4})$/.exec(schoolYear);
    if (!match) return false;

    return Number(match[2]) === Number(match[1]) + 1;
}
