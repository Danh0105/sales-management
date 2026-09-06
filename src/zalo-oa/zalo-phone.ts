/**
 * Tách số điện thoại Việt Nam ra khỏi tin nhắn người dùng gửi cho OA.
 *
 * Người ta gõ đủ kiểu: "0901234501", "090 123 4501", "+84901234501",
 * "sdt cua toi la 0901.234.501" — nên phải chuẩn hoá về đúng dạng đang lưu
 * trong `employee.phone` (bắt đầu bằng 0) rồi mới đem đi so.
 */

/** Các cách viết mã quốc gia hay gặp, đổi hết về "0". */
const COUNTRY_PREFIX = /^(?:\+?84|0084)/;

export function extractVietnamPhone(text: string): string | null {
    if (!text) return null;

    // Bỏ mọi ký tự không phải số, trừ dấu + ở đầu mã quốc gia.
    const digits = text.replace(/[^\d+]/g, '');
    if (!digits) return null;

    const normalized = digits.replace(COUNTRY_PREFIX, '0');

    // Số di động VN: 0 + 9 chữ số. Nới tới 10 để chịu được số cố định cũ.
    const match = normalized.match(/0\d{8,10}/);

    return match ? match[0] : null;
}

/** Từ khoá huỷ nhận cảnh báo — chấp nhận cả có dấu lẫn không dấu. */
const UNLINK_KEYWORDS = [
    'huy',
    'huỷ',
    'hủy',
    'stop',
    'ngung',
    'ngừng',
    'unlink',
];

export function isUnlinkCommand(text: string): boolean {
    const normalized = (text || '').trim().toLowerCase();
    if (!normalized) return false;

    // So khớp cả câu để "huỷ nhận cảnh báo" cũng ăn, nhưng không để một chữ
    // "huy" lọt giữa câu dài thành lệnh huỷ ngoài ý muốn.
    return UNLINK_KEYWORDS.some(
        (keyword) => normalized === keyword || normalized.startsWith(`${keyword} `),
    );
}
