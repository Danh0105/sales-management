/**
 * So khớp tên tiếng Việt đọc từ ảnh với tên trong database.
 *
 * Toàn bộ chạy trong bộ nhớ: hệ thống có ~240 trường, vài trăm môn và vài chục
 * giáo viên, nên nạp hết rồi chấm điểm đơn giản hơn và đoán được hơn nhiều so
 * với đẩy fuzzy match xuống SQL.
 */

/** Bỏ dấu, hạ chữ thường, gộp khoảng trắng. */
export function normalize(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9/\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Từ chỉ loại hình trường — có ở hầu hết mọi tên nên không giúp phân biệt, và
 * để lại thì "Trường Tiểu học A" khớp nhầm với "Trường Tiểu học B".
 */
const SCHOOL_TYPE_WORDS = [
    'truong',
    'tieu hoc',
    'trung hoc co so',
    'trung hoc pho thong',
    'mam non',
    'mau giao',
    'thcs',
    'thpt',
    'th',
    'mn',
];

/** Phần tên riêng: "Trường Tiểu học Phước Hiệp" -> "phuoc hiep". */
export function schoolCore(value: string): string {
    let core = normalize(value);
    for (const word of SCHOOL_TYPE_WORDS) {
        core = core.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ');
    }
    return core.replace(/\s+/g, ' ').trim();
}

/** Loại hình trường đọc được từ tên, dùng để tách "Tiểu học X" khỏi "Mầm non X". */
export function schoolKind(value: string): string | null {
    const text = normalize(value);
    if (/\btieu hoc\b|\bth\b/.test(text)) return 'TIEU_HOC';
    if (/\btrung hoc co so\b|\bthcs\b/.test(text)) return 'THCS';
    if (/\btrung hoc pho thong\b|\bthpt\b/.test(text)) return 'THPT';
    if (/\bmam non\b|\bmau giao\b|\bmn\b/.test(text)) return 'MAM_NON';
    return null;
}

function tokens(value: string): Set<string> {
    return new Set(value.split(' ').filter(Boolean));
}

/** Jaccard trên tập từ — 1 là trùng khít, 0 là không chung từ nào. */
export function similarity(a: string, b: string): number {
    const left = tokens(a);
    const right = tokens(b);
    if (left.size === 0 || right.size === 0) return 0;

    let shared = 0;
    for (const token of left) if (right.has(token)) shared += 1;

    return shared / (left.size + right.size - shared);
}

export interface Candidate<T> {
    item: T;
    score: number;
}

/**
 * Chấm điểm và sắp xếp giảm dần, cắt bỏ những mục quá khác biệt.
 * Trả về nhiều mục thì tầng trên sẽ hỏi lại Nhân sự thay vì tự đoán.
 */
export function rank<T>(
    items: T[],
    query: string,
    toText: (item: T) => string,
    options: { minScore?: number; limit?: number; bonus?: (item: T) => number } = {},
): Candidate<T>[] {
    const { minScore = 0.34, limit = 5, bonus } = options;
    const needle = normalize(query);
    if (!needle) return [];

    return items
        .map((item) => {
            const haystack = normalize(toText(item));
            // Chứa trọn vẹn thì chắc chắn đúng hơn mọi điểm token nào khác.
            const contains =
                haystack.includes(needle) || needle.includes(haystack) ? 0.6 : 0;
            const score =
                Math.min(1, similarity(needle, haystack) + contains) +
                (bonus?.(item) ?? 0);
            return { item, score };
        })
        .filter((c) => c.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}
