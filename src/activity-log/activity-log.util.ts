/** Field không bao giờ được ghi xuống nhật ký, dù nằm ở cấp nào của body. */
const SECRET_KEYS = [
  'password',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'zalotoken',
  'zaloaccesstoken',
  'zalorefreshtoken',
  'otp',
  'secret',
];

/** Body quá lớn (import thời khoá biểu vài nghìn dòng) làm phình bảng log. */
const MAX_SERIALIZED_LENGTH = 20_000;

function isSecret(key: string): boolean {
  return SECRET_KEYS.includes(key.toLowerCase());
}

/**
 * Che mật khẩu và cắt các mảng quá dài. Giữ nguyên cấu trúc còn lại để người
 * đọc log thấy đúng payload mà client đã gửi.
 */
export function sanitizeBody(value: unknown, depth = 0): any {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 6) return '[truncated: quá sâu]';

  if (Array.isArray(value)) {
    const kept = value.slice(0, 200).map((v) => sanitizeBody(v, depth + 1));
    return value.length > 200
      ? [...kept, `[... ${value.length - 200} phần tử nữa]`]
      : kept;
  }

  if (Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecret(key) ? '***' : sanitizeBody(v, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}… [cắt bớt ${value.length - 2000} ký tự]`;
  }

  return value;
}

/** Bản ghi cuối cùng vẫn có thể quá lớn sau khi che — chốt chặn cuối. */
export function capPayload(value: any): any {
  if (value === null || value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_SERIALIZED_LENGTH) {
      return { _truncated: true, _size: serialized.length };
    }
    return value;
  } catch {
    return { _unserializable: true };
  }
}

/** File upload chỉ ghi metadata, không ghi nội dung. */
export function describeFiles(req: any): any {
  const files = req?.files ?? (req?.file ? [req.file] : null);
  const list = Array.isArray(files)
    ? files
    : files && typeof files === 'object'
      ? Object.values(files).flat()
      : null;

  if (!list?.length) return null;

  return list.map((f: any) => ({
    field: f?.fieldname,
    name: f?.originalname,
    size: f?.size,
    mimetype: f?.mimetype,
  }));
}

/** `/teachers/12/approve` → `teachers`. */
export function resourceOf(path: string): string {
  return path.split('?')[0].split('/').filter(Boolean)[0] ?? '/';
}

/**
 * ===== Bối cảnh dễ đọc =====
 *
 * Nhật ký thô chỉ có id (`schoolId: 12`, `teacherId: 5`) — người đọc phải tự
 * tra từng bảng. Response của endpoint thì gần như luôn kèm sẵn quan hệ
 * (`school.name`, `teacher.name`, `class.name`, ngày/giờ tiết), nên chốt lại
 * ngay lúc ghi log: tra sau vài tháng vẫn ra đúng tên **tại thời điểm đó**, kể
 * cả khi trường đã đổi tên hoặc lớp đã bị xoá.
 */
export interface ActivityContext {
  schoolName?: string;
  className?: string;
  teacherName?: string;
  subjectName?: string;
  employeeName?: string;
  schoolYear?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  periods?: number;
  /** Endpoint hàng loạt trả về mảng — ghi số lượng thay vì nhồi cả mảng. */
  itemCount?: number;

  /**
   * Id của trường/giáo viên liên quan, để **lọc** nhật ký.
   *
   * Tên thì chốt lại được nhưng lọc theo tên thì hỏng ngay khi trường đổi tên
   * hoặc hai giáo viên trùng tên. Là mảng vì một thao tác hàng loạt chạm tới
   * nhiều trường cùng lúc; `schoolId`/`teacherId` chỉ có khi đúng một.
   */
  schoolId?: number;
  teacherId?: number;
  schoolIds?: number[];
  teacherIds?: number[];
}

/** Quan hệ → tên field trong bối cảnh. */
export const RELATION_FIELDS: Record<string, keyof ActivityContext> = {
  school: 'schoolName',
  class: 'className',
  teacher: 'teacherName',
  subject: 'subjectName',
  employee: 'employeeName',
};

const SCALAR_FIELDS: (keyof ActivityContext)[] = [
  'schoolYear',
  'date',
  'startTime',
  'endTime',
  'periods',
];

const isPlainObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Gom bối cảnh từ response, thiếu đâu bù bằng request body.
 *
 * Chỉ đi sâu tối đa 3 cấp và **không** ghi đè giá trị đã tìm được: quan hệ ở
 * cấp nông (chính bản ghi vừa sửa) mới là thứ người đọc cần, cấp sâu hơn
 * (`schedule.class.school`) thường chỉ lặp lại hoặc lạc đề.
 */
export function extractContext(response: unknown, body: unknown): ActivityContext | null {
  const ctx: ActivityContext = {};

  const visit = (node: unknown, depth: number) => {
    if (depth > 3 || !isPlainObject(node)) return;

    for (const [key, value] of Object.entries(node)) {
      const relation = RELATION_FIELDS[key];
      if (relation && isPlainObject(value) && typeof value.name === 'string') {
        (ctx as any)[relation] ??= value.name;
        // Vẫn đi tiếp vào trong: năm học nằm trong `class`, không ở cấp gốc.
        visit(value, depth + 1);
        continue;
      }

      // Dạng phẳng: `schoolName`, `teacherName`… có ở một số DTO đọc.
      if (
        (Object.values(RELATION_FIELDS) as string[]).includes(key) &&
        typeof value === 'string'
      ) {
        (ctx as any)[key] ??= value;
        continue;
      }

      if (
        (SCALAR_FIELDS as string[]).includes(key) &&
        (typeof value === 'string' || typeof value === 'number')
      ) {
        (ctx as any)[key] ??= value;
        continue;
      }

      if (isPlainObject(value)) visit(value, depth + 1);
    }
  };

  const root = Array.isArray(response) ? response[0] : response;
  if (Array.isArray(response)) ctx.itemCount = response.length;
  else if (isPlainObject(response) && Array.isArray((response as any).data)) {
    ctx.itemCount = (response as any).data.length;
    visit((response as any).data[0], 1);
  }

  visit(root, 0);
  // Body là nguồn cuối: endpoint xoá không trả gì, nhưng payload vẫn có thể có tên.
  visit(body, 0);

  return Object.keys(ctx).length ? ctx : null;
}

/** Một field đã đổi giá trị, để nhật ký kể được "trước / sau". */
export interface FieldChange {
  field: string;
  before: any;
  after: any;
}

/** So sánh nông — đủ cho các cột vô hướng; quan hệ đã có ở `context`. */
function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as any).getTime() === new Date(b as any).getTime();
  }
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  // `12` và `'12'` là cùng một giá trị với người đọc — TypeORM trả decimal
  // dạng chuỗi ở vài chỗ, so thẳng thì dòng nào cũng báo "đã đổi".
  return String(a) === String(b);
}

/**
 * Các field thực sự đổi giữa hai bản chụp. Chỉ giữ field đổi: liệt kê cả bản
 * ghi thì người đọc phải tự dò xem cái gì khác, đúng việc mà nhật ký sinh ra
 * để khỏi phải làm.
 */
export function diffSnapshots(
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
  ignored: string[] = [],
): FieldChange[] {
  if (!before && !after) return [];

  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  const changes: FieldChange[] = [];
  for (const field of keys) {
    if (ignored.includes(field)) continue;

    const from = before?.[field];
    const to = after?.[field];
    if (sameValue(from, to)) continue;

    changes.push({
      field,
      before: sanitizeBody(from ?? null),
      after: sanitizeBody(to ?? null),
    });
  }

  return changes;
}

/**
 * Bỏ các field kỹ thuật khỏi từng phần tử của một mảng bản ghi.
 *
 * Dùng cho bảng con (bảng tiết, cập nhật hàng loạt): dấu thời gian và id tự
 * sinh đổi sau mỗi lần lưu, giữ lại thì mảng nào cũng bị coi là "đã đổi".
 */
export function stripRowFields<T>(rows: T[], ignored: string[]): any[] {
  return rows.map((row) => {
    if (!isPlainObject(row)) return row;
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!ignored.includes(key)) out[key] = value;
    }
    return out;
  });
}

/**
 * Đổi quan hệ đã nạp thành tên phẳng: `{ school: { id, name } }` → `{ schoolName }`.
 *
 * Bỏ hẳn object quan hệ sau khi lấy tên. Giữ lại thì mỗi lần một bảng liên quan
 * đổi (đổi số học sinh của lớp chẳng hạn) nhật ký lại báo "lịch dạy đã đổi",
 * trong khi lịch dạy không hề bị sửa.
 */
export function flattenRelationNames(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};

  for (const [key, value] of Object.entries(row)) {
    const nameField = RELATION_FIELDS[key];
    if (nameField && isPlainObject(value)) {
      if (typeof value.name === 'string') out[nameField] = value.name;
      // Năm học nằm ở lớp chứ không ở lịch dạy, mà thiếu nó thì "8/1" của năm
      // nào cũng như nhau.
      if (typeof value.schoolYear === 'string') out.schoolYear ??= value.schoolYear;
      // Quan hệ không có cột `name` thì bỏ hẳn, đừng nhồi cả object vào log.
      continue;
    }
    out[key] = value;
  }

  return out;
}

/** Giữ đúng các field đã khai, theo thứ tự đã khai. Field thiếu thì bỏ qua. */
export function pickFields(row: Record<string, any>, fields: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of fields) {
    if (row[field] !== undefined) out[field] = row[field];
  }
  return out;
}

/**
 * Gom mọi giá trị của một field id trong bản chụp, kể cả nằm trong mảng.
 *
 * Một lô lịch dạy chạm tới nhiều trường; lấy mỗi id đầu tiên thì lọc "nhật ký
 * của trường X" sẽ bỏ sót đúng những thao tác hàng loạt cần soi nhất.
 */
export function collectIds(source: unknown, field: string, depth = 0): number[] {
  if (depth > 3) return [];

  if (Array.isArray(source)) {
    return source.flatMap((item) => collectIds(item, field, depth + 1));
  }
  if (!isPlainObject(source)) return [];

  const found: number[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === field) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0) found.push(id);
      continue;
    }
    if (value && typeof value === 'object') {
      found.push(...collectIds(value, field, depth + 1));
    }
  }

  return [...new Set(found)];
}
