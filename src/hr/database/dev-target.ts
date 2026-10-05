/**
 * Chốt chặn đích kết nối cho công cụ SQL dùng trong phát triển HR.
 *
 * Công cụ này được phép chạy không cần hỏi lại (xem `.claude/settings.local.json`),
 * nên nó phải TỰ từ chối mọi đích không phải DB test local — không dựa vào việc
 * người gọi "nhớ" trỏ đúng. `sales_db` trên server là DB dùng chung prod/dev.
 */
export const DEV_DATABASE = 'sales_db_hr_dev';
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

export interface DevTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

/**
 * Tách và kiểm tra URL. Trả về thông số kết nối tường minh để driver không tự
 * suy thêm gì từ chuỗi URL (vd. `?host=` ghi đè host, hay `options=`).
 */
export function parseDevTarget(url: string | undefined): DevTarget {
  if (!url) {
    throw new Error('Thiếu HR_MIGRATION_DATABASE_URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('HR_MIGRATION_DATABASE_URL không phải URL hợp lệ.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`Chỉ hỗ trợ postgres://, nhận được "${parsed.protocol}".`);
  }

  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new Error(
      `Từ chối host "${host}": công cụ này chỉ chạy trên localhost.`,
    );
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database !== DEV_DATABASE) {
    throw new Error(
      `Từ chối database "${database}": chỉ được dùng "${DEV_DATABASE}".`,
    );
  }

  if ([...parsed.searchParams.keys()].length) {
    throw new Error(
      'URL không được có tham số (?host=, ?options=... có thể đổi đích kết nối).',
    );
  }

  return {
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/** Kiểm tra lại SAU khi kết nối — phòng trường hợp port forward/alias trỏ nhầm. */
export function assertConnectedToDev(info: {
  db: string;
  addr: string | null;
}): void {
  if (info.db !== DEV_DATABASE) {
    throw new Error(
      `Đã kết nối vào "${info.db}" thay vì "${DEV_DATABASE}" — dừng.`,
    );
  }
  // `inet_server_addr()` là NULL khi đi qua unix socket; còn lại phải là loopback.
  const addr = info.addr?.replace(/\/\d+$/, '') ?? null;
  if (addr !== null && !['127.0.0.1', '::1'].includes(addr)) {
    throw new Error(`Server trả địa chỉ ${addr}, không phải loopback — dừng.`);
  }
}

/**
 * Các lệnh bị chặn kể cả trên DB test: tác động ra ngoài DB này
 * (cả cluster, file hệ thống) chứ không chỉ dữ liệu thử.
 */
const BLOCKED_STATEMENTS: { pattern: RegExp; message: string }[] = [
  { pattern: /\bDROP\s+DATABASE\b/i, message: 'DROP DATABASE' },
  { pattern: /\bCREATE\s+DATABASE\b/i, message: 'CREATE DATABASE' },
  { pattern: /\bALTER\s+SYSTEM\b/i, message: 'ALTER SYSTEM' },
  {
    pattern: /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b/i,
    message: 'quản lý ROLE/USER',
  },
  {
    pattern: /\bCOPY\b[\s\S]*\b(?:PROGRAM|TO\s+'|FROM\s+')/i,
    message: 'COPY ra/vào file hoặc chương trình',
  },
  {
    pattern: /\bpg_(?:read|write)_(?:binary_)?file\b|\blo_(?:import|export)\b/i,
    message: 'đọc/ghi file hệ thống',
  },
];

export function assertStatementAllowed(sql: string): void {
  const hit = BLOCKED_STATEMENTS.find((rule) => rule.pattern.test(sql));
  if (hit) throw new Error(`Lệnh bị chặn: ${hit.message}.`);
}
