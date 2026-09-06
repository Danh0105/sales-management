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
