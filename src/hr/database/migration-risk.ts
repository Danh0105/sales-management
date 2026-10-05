/**
 * Phân loại rủi ro và luật an toàn cho migration HR.
 *
 * Migration HR là SQL viết tay (entity HR có `synchronize: false` nên
 * `migration:generate` không sinh được). Mỗi file tự khai báo mức rủi ro qua
 * `static readonly risk`, và `checkMigrationSource` chặn các câu lệnh phá dữ
 * liệu ngay từ lúc chạy test — trước khi file có cơ hội tới gần database.
 */
export const MIGRATION_RISKS = ['SAFE', 'CAUTION', 'DANGEROUS'] as const;
export type MigrationRisk = (typeof MIGRATION_RISKS)[number];

/** Tên file: `<timestamp 13 số>-hr-<mô-tả-kebab>.ts` (hoặc `.js` sau khi build). */
export const HR_MIGRATION_FILENAME =
  /^(\d{13})-hr-[a-z0-9]+(?:-[a-z0-9]+)*\.(?:ts|js)$/;

/**
 * Dải timestamp của HR bắt đầu sau migration cuối của luồng cũ, để khi đọc
 * lẫn hai thư mục vẫn nhận ra ngay file nào của HR.
 */
export const HR_MIGRATION_MIN_TIMESTAMP = 1791700000000;

/**
 * Bảng duy nhất ngoài schema `hr` mà migration HR được phép nhắc tới — và chỉ
 * trong mệnh đề `REFERENCES` (FK từ hồ sơ HR về tài khoản đăng nhập).
 */
const ALLOWED_PUBLIC_REFERENCE =
  /REFERENCES\s+"?public"?\s*\.\s*"?employee"?\s*\(\s*"?id"?\s*\)/gi;

interface Rule {
  pattern: RegExp;
  message: string;
}

/** Cấm ở mọi nơi trong file, kể cả `down()`. */
const FORBIDDEN_ANYWHERE: Rule[] = [
  // `(?!\s+ON\b)`: `BEFORE ... OR TRUNCATE ON "hr"."x"` là khai báo trigger, không phải câu lệnh.
  { pattern: /\bTRUNCATE\b(?!\s+ON\b)/i, message: 'TRUNCATE bị cấm' },
  { pattern: /\bDROP\s+DATABASE\b/i, message: 'DROP DATABASE bị cấm' },
  {
    pattern: /\bDROP\s+SCHEMA\b/i,
    message: 'DROP SCHEMA bị cấm (xoá schema là thao tác tay của DBA)',
  },
  {
    pattern: /\bCASCADE\b/i,
    message: 'CASCADE bị cấm — có thể kéo theo dữ liệu ngoài ý muốn',
  },
  {
    pattern: /\bALTER\s+COLUMN\s+[^;`]*?\bTYPE\b/i,
    message: 'Đổi kiểu cột (ALTER COLUMN ... TYPE) là DANGEROUS',
  },
  {
    pattern: /\bRENAME\b/i,
    message: 'RENAME bị cấm — dùng expand/contract thay vì đổi tên',
  },
  { pattern: /\bDROP\s+COLUMN\b/i, message: 'DROP COLUMN là DANGEROUS' },
];

/** Cấm trong `up()`; `down()` được gỡ đối tượng vừa tạo (có guard dữ liệu). */
const FORBIDDEN_IN_UP: Rule[] = [
  {
    pattern: /\bDROP\s+(TABLE|TYPE|INDEX|FUNCTION|VIEW)\b/i,
    message: 'up() không được DROP đối tượng',
  },
  { pattern: /\bDELETE\s+FROM\b/i, message: 'up() không được DELETE dữ liệu' },
];

/**
 * DDL phải ghi rõ schema `hr` — thiếu schema là rơi vào `public`.
 * `(?!IF\b|ONLY\b)` chặn regex backtrack bỏ qua nhóm tuỳ chọn rồi đem chữ
 * `IF`/`ONLY` ra so với "hr".
 */
const UNQUALIFIED_DDL: Rule[] = [
  {
    pattern:
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?!IF\b)(?!"?hr"?\s*\.)/i,
    message: 'CREATE TABLE phải ghi rõ schema hr ("hr"."ten_bang")',
  },
  {
    pattern:
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?!IF\b|ONLY\b)(?!"?hr"?\s*\.)/i,
    message: 'ALTER TABLE chỉ được áp lên bảng trong schema hr',
  },
  {
    pattern:
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s+ON\s+(?!"?hr"?\s*\.)/i,
    message: 'CREATE INDEX chỉ được tạo trên bảng trong schema hr',
  },
  {
    pattern: /\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+(?!"?hr"?\s*\.)/i,
    message: 'Ghi dữ liệu chỉ được làm trên bảng trong schema hr',
  },
  {
    // Chỉ bắt câu `UPDATE <bảng> [alias] SET` — không nhầm với `ON UPDATE` của FK
    // hay `BEFORE UPDATE OR ...` của trigger.
    pattern:
      /\bUPDATE\s+(?:ONLY\s+)?(?!"?hr"?\s*\.)[\w"]+(?:\s*\.\s*[\w"]+)?(?:\s+(?:AS\s+)?\w+)?\s+SET\b/i,
    message: 'Ghi dữ liệu chỉ được làm trên bảng trong schema hr',
  },
  {
    pattern: /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?!"?hr"?\s*\.)/i,
    message: 'FUNCTION phải nằm trong schema hr',
  },
  {
    // Chỉ xét chữ ON ĐẦU TIÊN sau tên trigger — không backtrack sang `ON UPDATE` của câu khác.
    pattern:
      /\bCREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?\w+"?(?:(?!\bON\b)[\s\S])*\bON\s+(?!"?hr"?\s*\.)/i,
    message: 'TRIGGER chỉ được gắn lên bảng trong schema hr',
  },
];

const RISK_DECLARATION =
  /static\s+readonly\s+risk\s*(?::\s*MigrationRisk\s*)?=\s*'(SAFE|CAUTION|DANGEROUS)'/;

export function readDeclaredRisk(source: string): MigrationRisk | null {
  return (source.match(RISK_DECLARATION)?.[1] as MigrationRisk) ?? null;
}

/**
 * Kiểm tra tĩnh một file migration HR. Trả về danh sách vi phạm — rỗng là đạt.
 *
 * Đây là lưới an toàn, không phải trình phân tích SQL đầy đủ: nó cố ý bắt
 * quá tay (false positive) hơn là bỏ lọt. Gặp false positive thì viết lại câu
 * lệnh cho rõ ràng, không nới luật.
 */
export function checkMigrationSource(
  filename: string,
  source: string,
): string[] {
  const violations: string[] = [];
  const fail = (message: string) => violations.push(`${filename}: ${message}`);

  const match = filename.match(HR_MIGRATION_FILENAME);
  if (!match) {
    fail('tên file phải có dạng <timestamp>-hr-<mo-ta>.ts');
  } else {
    const timestamp = Number(match[1]);
    if (timestamp < HR_MIGRATION_MIN_TIMESTAMP) {
      fail(`timestamp phải >= ${HR_MIGRATION_MIN_TIMESTAMP}`);
    }
    if (!new RegExp(`class\\s+\\w+${match[1]}\\b`).test(source)) {
      fail('tên class phải kết thúc bằng đúng timestamp của file');
    }
  }

  const risk = readDeclaredRisk(source);
  if (!risk) fail("thiếu `static readonly risk = 'SAFE' | 'CAUTION'`");
  if (risk === 'DANGEROUS')
    fail('migration DANGEROUS không được đưa vào luồng HR');

  // Bỏ comment để câu chữ giải thích (vd. "không DROP SCHEMA") không bị bắt nhầm.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const downIndex = code.search(/\basync\s+down\s*\(/);
  const up = downIndex === -1 ? code : code.slice(0, downIndex);

  for (const rule of FORBIDDEN_ANYWHERE)
    if (rule.pattern.test(code)) fail(rule.message);
  for (const rule of FORBIDDEN_IN_UP)
    if (rule.pattern.test(up)) fail(rule.message);
  for (const rule of UNQUALIFIED_DDL)
    if (rule.pattern.test(code)) fail(rule.message);

  const withoutAllowedFk = code.replace(ALLOWED_PUBLIC_REFERENCE, '');
  if (/"?public"?\s*\.\s*"?\w+/i.test(withoutAllowedFk)) {
    fail('chỉ được tham chiếu public.employee(id) trong REFERENCES');
  }

  return violations;
}

/** Timestamp trùng làm thứ tự chạy không xác định (luồng cũ đã dính 2 lần). */
export function findDuplicateTimestamps(filenames: string[]): string[] {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const name of filenames) {
    const ts = name.match(HR_MIGRATION_FILENAME)?.[1];
    if (!ts) continue;
    const previous = seen.get(ts);
    if (previous) duplicates.push(`${previous} <-> ${name}`);
    else seen.set(ts, name);
  }
  return duplicates;
}

export interface PendingMigration {
  name: string;
  risk: MigrationRisk | null;
}

export interface ApplyGuardInput {
  apply: boolean;
  confirmDb?: string;
  actualDb: string;
  nodeEnv?: string;
  allowProduction?: string;
  allowCaution: boolean;
  pending: PendingMigration[];
}

/**
 * Quyết định runner có được thực thi hay không. Ném lỗi với lý do cụ thể —
 * runner in ra và thoát mã khác 0, không có đường "cứ chạy tiếp".
 */
export function assertApplyAllowed(input: ApplyGuardInput): void {
  if (!input.apply) {
    throw new Error('Chế độ xem trước (dry-run). Thêm --apply để thực thi.');
  }

  if (!input.confirmDb) {
    throw new Error(
      `Thiếu --confirm-db=<tên database>. Database đang kết nối: "${input.actualDb}".`,
    );
  }

  if (input.confirmDb !== input.actualDb) {
    throw new Error(
      `--confirm-db="${input.confirmDb}" không khớp database đang kết nối "${input.actualDb}".`,
    );
  }

  if (input.nodeEnv === 'production' && input.allowProduction !== 'yes') {
    throw new Error(
      'NODE_ENV=production: cần HR_ALLOW_PRODUCTION_MIGRATION=yes do người vận hành tự đặt.',
    );
  }

  const unlabeled = input.pending.filter((m) => !m.risk);
  if (unlabeled.length) {
    throw new Error(
      `Migration thiếu nhãn rủi ro: ${unlabeled.map((m) => m.name).join(', ')}`,
    );
  }

  const dangerous = input.pending.filter((m) => m.risk === 'DANGEROUS');
  if (dangerous.length) {
    throw new Error(
      `Từ chối migration DANGEROUS: ${dangerous.map((m) => m.name).join(', ')}`,
    );
  }

  const caution = input.pending.filter((m) => m.risk === 'CAUTION');
  if (caution.length && !input.allowCaution) {
    throw new Error(
      `Có migration CAUTION (${caution.map((m) => m.name).join(', ')}). ` +
        'Đọc kỹ rồi thêm --allow-caution nếu chấp nhận.',
    );
  }
}
