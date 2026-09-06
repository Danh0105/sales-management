import { PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsArray,
  ArrayUnique,
  MaxLength,
  Max,
  Min,
  MinLength,
  Matches,
} from 'class-validator';
import { TEACHER_ROLES } from '../teaching-roles';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

const toNullableTrimmedString = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  const normalized = value.trim();
  return normalized || null;
};

const toNumberArray = ({ value }: { value: unknown }) =>
  Array.isArray(value) ? value.map((item) => Number(item)) : value;

export class CreateTeacherDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name!: string;

  @Transform(trim)
  @IsString()
  @MaxLength(20)
  @Matches(/^0\d{9,10}$/, { message: 'Số điện thoại không hợp lệ' })
  phone!: string;

  @Transform(trim)
  @IsEmail({}, { message: 'email không hợp lệ' })
  email!: string;

  /** Có password và không có employeeId: tạo tài khoản role giaovien trong transaction. */
  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  @MaxLength(100)
  password?: string;

  /** Gắn tài khoản đăng nhập cho giáo viên cơ hữu; bỏ trống với giáo viên thuê ngoài. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  /**
   * Loại giáo viên khi tạo kèm tài khoản đăng nhập mới (có `password`) —
   * quyết định role gán cho tài khoản đó. Không dùng đến khi gắn `employeeId`
   * có sẵn (role của tài khoản đó do Nhân sự quản lý ở màn Nhân viên).
   * Bỏ trống mặc định là giáo viên công ty.
   */
  @IsOptional()
  @IsIn(TEACHER_ROLES, {
    message: `teacherRole phải là một trong: ${TEACHER_ROLES.join(', ')}`,
  })
  teacherRole?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** Link vị trí Google Maps của giáo viên; gửi null/chuỗi rỗng để xoá. */
  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(500)
  @Matches(
    /^https:\/\/(?:(?:www\.)?google\.[a-z.]+\/maps(?:\/|\?|$)|maps\.google\.[a-z.]+(?:\/|\?|$)|maps\.app\.goo\.gl\/|goo\.gl\/maps\/)/i,
    { message: 'Vị trí phải là link Google Maps hợp lệ' },
  )
  googleMapsUrl?: string | null;

  /**
   * Danh sách xã/phường giáo viên nhận dạy — được toàn bộ trường thuộc các
   * xã/phường này. Mảng rỗng = chưa giới hạn xã/phường.
   */
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  wardIds?: number[];

  /** Danh sách môn có thể dạy, dùng ID của subject_catalogs. */
  @IsOptional()
  @Transform(toNumberArray)
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  subjectCatalogIds?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxPeriodsPerWeek?: number | null;

  /** null = xoá giá riêng và quay về dùng giá môn học. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100_000_000)
  defaultRatePerPeriod?: number | null;

  /** ID Zalo Mini App của giáo viên; gửi null/chuỗi rỗng để xoá. */
  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(100)
  zaloUid?: string | null;

  /** ID Zalo OA của giáo viên, dùng để gửi thông báo; gửi null/chuỗi rỗng để xoá. */
  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(100)
  zaloUserId?: string | null;
}

export class UpdateTeacherDto extends PartialType(CreateTeacherDto) {}

export class ResetTeacherPasswordDto {
  @IsOptional()
  @IsString()
  @MinLength(6, { message: 'Mật khẩu phải có ít nhất 6 ký tự' })
  @MaxLength(100)
  password?: string;
}

export class QueryTeachersDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  /** Chỉ giáo viên đang có lịch dạy tại trường này. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  schoolId?: number;

  /** Lọc một trong hai nhóm giáo viên trên cùng service danh sách. */
  @IsOptional()
  @IsIn(TEACHER_ROLES, {
    message: `teacherRole phải là một trong: ${TEACHER_ROLES.join(', ')}`,
  })
  teacherRole?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
