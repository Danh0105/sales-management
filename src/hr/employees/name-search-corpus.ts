/**
 * Bộ dữ liệu đối chiếu cho hợp đồng chuẩn hoá họ tên (v1): dùng cho unit test
 * và cho CLI chỉ đọc `hr:employees:verify-search`, CLI này chạy chính biểu
 * thức SQL của migration 0800 trên DB đích rồi so với
 * `normalizeVietnameseName()`.
 *
 * Mọi ký tự đặc biệt dựng từ code point — không viết trực tiếp.
 */
const cp = (...n: number[]) => String.fromCharCode(...n);

/** Nguyên âm gốc tiếng Việt (dạng tách dấu mũ/móc/trăng) → chữ ASCII mong đợi. */
const BASE_VOWELS: [string, string][] = [
  ['a', 'a'],
  [`a${cp(0x0306)}`, 'a'], // ă
  [`a${cp(0x0302)}`, 'a'], // â
  ['e', 'e'],
  [`e${cp(0x0302)}`, 'e'], // ê
  ['i', 'i'],
  ['o', 'o'],
  [`o${cp(0x0302)}`, 'o'], // ô
  [`o${cp(0x031b)}`, 'o'], // ơ
  ['u', 'u'],
  [`u${cp(0x031b)}`, 'u'], // ư
  ['y', 'y'],
];

/** Không dấu, sắc, huyền, hỏi, ngã, nặng. */
const TONES = ['', cp(0x0301), cp(0x0300), cp(0x0309), cp(0x0303), cp(0x0323)];

export interface CorpusEntry {
  input: string;
  expected: string;
}

/** 12 nguyên âm × 6 thanh × hoa/thường (NFC) + Đ/đ. */
export function vietnameseLetters(): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const [base, ascii] of BASE_VOWELS) {
    for (const tone of TONES) {
      const lower = `${base}${tone}`.normalize('NFC');
      out.push({ input: lower, expected: ascii });
      out.push({ input: lower.toUpperCase(), expected: ascii });
    }
  }
  out.push(
    { input: cp(0x0110), expected: 'd' },
    { input: cp(0x0111), expected: 'd' },
  );
  return out;
}

const NAMES: CorpusEntry[] = [
  { input: 'Nguyễn Đặng Hồng Ân', expected: 'nguyen dang hong an' },
  { input: 'Nguyễn Văn A', expected: 'nguyen van a' },
  { input: 'TRẦN THỊ BÍCH NGỌC', expected: 'tran thi bich ngoc' },
  { input: 'Lê Hữu Phước', expected: 'le huu phuoc' },
  { input: 'Phạm Thị Thu Hường', expected: 'pham thi thu huong' },
  { input: 'Đỗ Quỳnh Như', expected: 'do quynh nhu' },
  { input: 'Vũ Ngọc Ánh', expected: 'vu ngoc anh' },
  { input: 'Hoàng Thị Yến', expected: 'hoang thi yen' },
  { input: 'Bùi Xuân Trường', expected: 'bui xuan truong' },
  { input: 'Tạ Ơn', expected: 'ta on' },
  { input: 'Ưng Hoàng Phúc', expected: 'ung hoang phuc' },
  { input: "O'Brien Smith-Jones", expected: "o'brien smith-jones" },
  { input: 'name_with%wild', expected: 'name_with%wild' },
];

/** Khoảng trắng lạ: tab, xuống dòng, NBSP, U+2003, U+3000, BOM, nhiều dấu cách. */
function whitespaceCases(): CorpusEntry[] {
  return [
    { input: `  Nguyễn${cp(0x09)}Văn${cp(0x0a)}A  `, expected: 'nguyen van a' },
    { input: `Lê${cp(0xa0)}Văn${cp(0x2003)}Bình`, expected: 'le van binh' },
    {
      input: `${cp(0xfeff)}Đinh${cp(0x3000)}Lan${cp(0x2028)}`,
      expected: 'dinh lan',
    },
    { input: 'Trần    Thị     Mai', expected: 'tran thi mai' },
  ];
}

/**
 * Toàn bộ bộ đối chiếu: chữ cái + họ tên + khoảng trắng, mỗi mục ở cả NFC và
 * NFD (hai dạng phải cho cùng kết quả).
 */
export function nameSearchCorpus(): CorpusEntry[] {
  const nfc = [...vietnameseLetters(), ...NAMES, ...whitespaceCases()].map(
    (e) => ({ input: e.input.normalize('NFC'), expected: e.expected }),
  );
  const nfd = nfc.map((e) => ({
    input: e.input.normalize('NFD'),
    expected: e.expected,
  }));
  return [...nfc, ...nfd];
}
