import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HrEmployeeStatus } from '../entities/hr-employee.entity';
import type { AttendanceMode, Gender } from '../hr-employee-profile';
import {
  ATTENDANCE_MODES,
  GENDERS,
  normalizeProfileEmail,
  normalizeProfilePhone,
  PHONE_PATTERN,
  SEARCH_MAX_LENGTH,
} from '../hr-employee-profile';
import { ISO_DATE, Trim, TrimToNull } from './common';

/** Chuỗi rỗng → null; còn lại bỏ khoảng trắng/chấm/gạch nối. */
const PhoneInput = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const phone = normalizeProfilePhone(value);
    return phone === '' ? null : phone;
  });

/** Chuỗi rỗng → null; còn lại trim + chữ thường. */
const EmailInput = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const email = normalizeProfileEmail(value);
    return email === '' ? null : email;
  });

const PHONE_MESSAGE =
  'Số điện thoại gồm 8–15 chữ số, có thể bắt đầu bằng + (được phép dùng khoảng trắng, dấu chấm, gạch nối)';

/**
 * Trường hồ sơ cơ bản dùng chung cho tạo/sửa. `null` = xoá giá trị (chỉ
 * trường tuỳ chọn). Ngày sinh kiểm tra thêm ở service (không ở tương lai).
 *
 * KHÔNG có `fullNameSearch` (server tự tính), `employeeCode` (hệ thống sinh),
 * và ở PATCH không có `accountId` — gửi lên → 400 (`forbidNonWhitelisted`).
 */
class HrEmployeeProfileFields {
  @IsOptional()
  @IsIn(ATTENDANCE_MODES)
  attendanceMode?: AttendanceMode;

  @IsOptional()
  @TrimToNull()
  @Matches(ISO_DATE, { message: 'Ngày sinh phải có dạng YYYY-MM-DD' })
  dateOfBirth?: string | null;

  @IsOptional()
  @IsIn(GENDERS)
  gender?: Gender | null;

  @IsOptional()
  @PhoneInput()
  @IsString()
  @Matches(PHONE_PATTERN, { message: PHONE_MESSAGE })
  phone?: string | null;

  @IsOptional()
  @EmailInput()
  @IsEmail({}, { message: 'Email công việc không hợp lệ' })
  @MaxLength(254)
  workEmail?: string | null;

  @IsOptional()
  @EmailInput()
  @IsEmail({}, { message: 'Email cá nhân không hợp lệ' })
  @MaxLength(254)
  personalEmail?: string | null;
}

/**
 * Không có `employeeCode`: mã do hệ thống sinh (NV + 6 số).
 * Không gửi `attendanceMode` → UNASSIGNED (chưa phân loại).
 */
export class CreateHrEmployeeDto extends HrEmployeeProfileFields {
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName: string;

  /** Tài khoản đăng nhập gắn với hồ sơ (nếu có). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  accountId?: number;
}

/** Sửa hồ sơ cơ bản — bắt buộc `version` (optimistic lock). */
export class UpdateHrEmployeeDto extends HrEmployeeProfileFields {
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

export class ListHrEmployeesQuery {
  /**
   * Tìm theo mã NV (chính xác/tiền tố), họ tên (chứa, không dấu), SĐT (chứa,
   * bỏ khoảng trắng/chấm/gạch nối), email công việc/cá nhân (chứa, không phân
   * biệt hoa thường).
   */
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @IsIn(Object.values(HrEmployeeStatus))
  status?: HrEmployeeStatus;

  @IsOptional()
  @IsIn(ATTENDANCE_MODES)
  attendanceMode?: AttendanceMode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Kích thước trang: mặc định 25, tối đa 100 (lớn hơn → 100). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
