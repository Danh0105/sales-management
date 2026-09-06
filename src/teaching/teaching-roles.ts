import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthUser } from '../type/auth-user.type';

/**
 * Role slugs mới (lưu trong employee.roles: text[], cùng quy ước đặt tên
 * tiếng Việt không dấu như thuquy / ketoan_congno / troly_gd).
 */
export const HR_ROLE = 'nhansu';

/**
 * Giáo viên chia làm 2 loại: công ty (nhân sự chính thức) và cộng tác viên.
 * Quyền hiện tại giống hệt nhau — tách sẵn thành 2 role riêng để sau này giáo
 * viên công ty được bổ sung quyền riêng mà không phải sửa lại toàn bộ nơi
 * đang kiểm tra role giáo viên.
 */
export const TEACHER_STAFF_ROLE = 'giaovien_congty';
export const TEACHER_COLLABORATOR_ROLE = 'giaovien_ctv';
export const TEACHER_ROLES = [TEACHER_STAFF_ROLE, TEACHER_COLLABORATOR_ROLE];

/**
 * Giáo vụ — làm được mọi việc của Nhân sự **trừ** khai tiền: đơn giá mỗi tiết
 * của môn học, và các khoản phụ cấp khi chấm công.
 */
export const ACADEMIC_ROLE = 'giaovu';

/** Quản lý giáo viên, lớp, lịch dạy, chấm công. */
export const TEACHING_MANAGE_ROLES = [HR_ROLE, ACADEMIC_ROLE];

/**
 * Được phép khai tiền. Tách riêng khỏi `TEACHING_MANAGE_ROLES` vì đây là ranh
 * giới duy nhất giữa Nhân sự và Giáo vụ — giữ thành một hằng số để thêm role
 * mới sau này không phải đi sửa rải rác từng controller.
 */
export const TEACHING_RATE_ROLES = [HR_ROLE];

/**
 * Được duyệt hồ sơ mở tài khoản giáo viên. Giáo vụ khai được hồ sơ nhưng
 * không tự bật tài khoản: mở tài khoản là cấp quyền đăng nhập vào hệ thống,
 * và người chịu trách nhiệm nhân sự phải là người chốt.
 */
export const TEACHER_ACCOUNT_APPROVE_ROLES = [HR_ROLE];

/** Ban giám đốc xem được toàn bộ số liệu nhưng không sửa. */
export const TEACHING_VIEW_ONLY_ROLES = [
  'director',
  'director_la',
  'troly_gd',
  'ketoan_truong',
];

/** Mọi role được phép gọi các endpoint đọc. */
export const TEACHING_VIEW_ROLES = [
  ...TEACHING_MANAGE_ROLES,
  ...TEACHING_VIEW_ONLY_ROLES,
];

/**
 * Kinh doanh — chỉ **xem thời khoá biểu của trường mình phụ trách**
 * (`schools.employee_id`), và không thấy đơn giá tiết.
 *
 * Cố ý **không** gộp vào `TEACHING_VIEW_ROLES`: hằng số đó đang mở toàn bộ
 * endpoint đọc của module (giáo viên kèm đơn giá, chấm công, tiền công...).
 * Role này chỉ được bật ở đúng endpoint cần thiết.
 */
export const TEACHING_OWN_SCHOOLS_ROLES = ['sales'];

/** Endpoint "lịch của tôi" — giáo viên có tài khoản. */
export const TEACHING_SELF_ROLES = TEACHER_ROLES;

export type TeachingScope =
  | { kind: 'manage' }
  | { kind: 'view' }
  /** Chỉ lịch của các trường do nhân viên này phụ trách. */
  | { kind: 'own-schools'; employeeId: number }
  | { kind: 'self'; employeeId: number };

/**
 * Phạm vi luôn suy ra từ access token, không bao giờ từ query param.
 * Ưu tiên: quản lý > xem toàn bộ > chỉ dữ liệu của chính mình.
 */
export function resolveTeachingScope(user?: AuthUser): TeachingScope {
  if (!user?.id) {
    throw new UnauthorizedException('Token không hợp lệ');
  }

  const roles = user.roles ?? [];

  if (roles.some((r) => TEACHING_MANAGE_ROLES.includes(r))) {
    return { kind: 'manage' };
  }

  if (roles.some((r) => TEACHING_VIEW_ONLY_ROLES.includes(r))) {
    return { kind: 'view' };
  }

  if (roles.some((r) => TEACHER_ROLES.includes(r))) {
    return { kind: 'self', employeeId: user.id };
  }

  if (roles.some((r) => TEACHING_OWN_SCHOOLS_ROLES.includes(r))) {
    return { kind: 'own-schools', employeeId: user.id };
  }

  throw new ForbiddenException('Bạn không có quyền xem dữ liệu giảng dạy');
}

/** Chặn ghi với các role chỉ-xem, kể cả khi đã qua RolesGuard. */
export function assertCanManageTeaching(user?: AuthUser): void {
  const scope = resolveTeachingScope(user);

  if (scope.kind !== 'manage') {
    throw new ForbiddenException(
      'Chỉ phòng Nhân sự hoặc Giáo vụ được thao tác dữ liệu này',
    );
  }
}

/** Người này có quyền duyệt hồ sơ mở tài khoản giáo viên không. */
export function canApproveTeacherAccount(user?: AuthUser): boolean {
  return (user?.roles ?? []).some((r) =>
    TEACHER_ACCOUNT_APPROVE_ROLES.includes(r),
  );
}

/**
 * Giáo vụ tạo giáo viên thì chỉ ra được hồ sơ **chờ duyệt**; Nhân sự tạo thì
 * tài khoản có ngay — bắt chính người duyệt phải tự duyệt đề nghị của mình là
 * thêm một bước thừa mà không kiểm soát thêm được gì.
 */
export function requiresTeacherAccountApproval(user?: AuthUser): boolean {
  assertCanManageTeaching(user);
  return !canApproveTeacherAccount(user);
}

/** Có được khai tiền không (đơn giá tiết theo môn học, phụ cấp). */
export function canSetTeachingRates(user?: AuthUser): boolean {
  return (user?.roles ?? []).some((r) => TEACHING_RATE_ROLES.includes(r));
}

/**
 * Chặn Giáo vụ khai tiền.
 *
 * Cố ý **báo lỗi** thay vì lặng lẽ bỏ các field tiền khỏi payload: bỏ thầm thì
 * Giáo vụ nhập đơn giá, bấm lưu, thấy thành công, rồi vài tuần sau bảng công ra
 * số 0 mà không ai hiểu vì sao. Từ chối thẳng thì họ biết ngay phải nhờ Nhân sự.
 *
 * Chỉ chặn khi payload **thực sự có** field tiền — Giáo vụ vẫn sửa được mọi thứ
 * khác trên cùng một form, miễn là không đụng vào ô đơn giá.
 */
export function assertCanSetTeachingRates(
  user: AuthUser | undefined,
  payload: unknown,
  fields: readonly string[] = TEACHING_RATE_FIELDS,
): void {
  if (canSetTeachingRates(user)) return;

  const touched = collectRateFields(payload, fields);
  if (touched.length === 0) return;

  throw new ForbiddenException(
    `Giáo vụ không được khai ${touched.join(', ')}. ` +
      'Phần tiền do phòng Nhân sự phụ trách.',
  );
}

/** Tên field tiền, kèm nhãn tiếng Việt để thông báo lỗi đọc được. */
export const TEACHING_RATE_FIELD_LABELS: Record<string, string> = {
  ratePerPeriod: 'đơn giá mỗi tiết',
  defaultRatePerPeriod: 'đơn giá riêng của giáo viên',
  otherCosts: 'các khoản phụ cấp',
};

export const TEACHING_RATE_FIELDS = Object.keys(
  TEACHING_RATE_FIELD_LABELS,
) as readonly string[];

/**
 * Tìm field tiền ở cả cấp gốc lẫn trong `items[]` — các endpoint hàng loạt cho
 * phép đặt đơn giá riêng cho từng dòng, bỏ sót là thủng ngay.
 */
function collectRateFields(
  payload: unknown,
  fields: readonly string[],
): string[] {
  const found = new Set<string>();

  const scan = (node: unknown, depth: number) => {
    if (depth > 3 || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) scan(item, depth + 1);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      // `undefined` = client không gửi field đó. `null` thì có gửi — đó là
      // thao tác "xoá đơn giá", vẫn phải chặn.
      if (fields.includes(key) && value !== undefined) {
        found.add(TEACHING_RATE_FIELD_LABELS[key] ?? key);
      }
      if (key === 'items') scan(value, depth + 1);
    }
  };

  scan(payload, 0);
  return [...found];
}
