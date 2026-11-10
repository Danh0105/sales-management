import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  ApproverType,
  FinanceRole,
  FinancialRequestType,
  SelfApprovalMode,
  SignatureSlot,
} from '../financial-request.constants';

const emptyToNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export class CompanyDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,30}$/, {
    message: 'Mã công ty chỉ gồm chữ, số, gạch nối (tối đa 30 ký tự)',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(100)
  shortName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(/^[0-9-]{8,30}$/, { message: 'Mã số thuế không hợp lệ' })
  taxCode?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsObject()
  formCodes?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(100)
  shortName?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Matches(/^[0-9-]{8,30}$/, { message: 'Mã số thuế không hợp lệ' })
  taxCode?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(50)
  phone?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEmail()
  @MaxLength(255)
  email?: string | null;

  @IsOptional()
  @IsObject()
  formCodes?: Record<string, string>;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryDto {
  @IsString()
  @Matches(/^[A-Z0-9_]{1,50}$/, {
    message: 'Mã danh mục: chữ in hoa, số, gạch dưới',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limitAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limitAmount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class WorkflowStepDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(SignatureSlot)
  signatureSlot?: SignatureSlot | null;

  @IsEnum(ApproverType)
  approverType!: ApproverType;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(FinanceRole)
  approverRole?: FinanceRole | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  approverEmployeeId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minAmount?: number | null;

  @IsOptional()
  @IsBoolean()
  canAdjustAmounts?: boolean;

  @IsOptional()
  @IsBoolean()
  skippable?: boolean;
}

export class WorkflowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  companyId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(FinancialRequestType)
  requestType?: FinancialRequestType | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isSequential?: boolean;

  @IsOptional()
  @IsEnum(SelfApprovalMode)
  selfApprovalMode?: SelfApprovalMode;

  @IsOptional()
  @IsBoolean()
  allowWithdraw?: boolean;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsArray()
  @ArrayMinSize(1, { message: 'Quy trình phải có ít nhất một cấp duyệt' })
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStepDto)
  steps!: WorkflowStepDto[];
}

export class AssignmentDto {
  @Type(() => Number)
  @IsInt()
  employeeId!: number;

  @IsEnum(FinanceRole)
  role!: FinanceRole;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  companyId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  departmentId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  approvalLimit?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** Vai trò "Nhân viên": xếp nhân viên vào phòng ban (không phải vai trò tài chính). */
export class EmployeeDepartmentDto {
  @Type(() => Number)
  @IsInt()
  departmentId!: number;

  /** Công ty nhân viên thuộc về; bỏ trống = giữ nguyên. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyId?: number;
}

/** Tài khoản đăng nhập mới tạo từ màn Phân quyền — luôn mang role hệ thống `employee`. */
export class CreateAccountDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2, { message: 'Nhập họ tên' })
  @MaxLength(255)
  name!: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/[\s.-]/g, '') : value,
  )
  @Matches(/^\+?\d{9,15}$/, { message: 'Số điện thoại không hợp lệ' })
  phone!: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @IsEmail({}, { message: 'Email không hợp lệ' })
  @MaxLength(255)
  email?: string | null;

  @IsString()
  @MinLength(6, { message: 'Mật khẩu tối thiểu 6 ký tự' })
  @MaxLength(72)
  password!: string;

  @Type(() => Number)
  @IsInt({ message: 'Chọn phòng ban' })
  departmentId!: number;
}

export class PolicyDto {
  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  companyId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  salaryAdvanceMaxPerMonth?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  salaryAdvanceMaxAmount?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(100)
  salaryAdvanceMaxPercent?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  maxDeductionPeriods?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  advanceDueDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  reminderDaysBefore?: number;

  @IsOptional()
  @IsIn(['WARN', 'BLOCK'])
  expenseOverLimitMode?: 'WARN' | 'BLOCK';
}

export class DelegationDto {
  /** Bỏ trống = chính người đang đăng nhập uỷ quyền. Chỉ quản trị được uỷ quyền thay người khác. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  delegatorId?: number;

  @Type(() => Number)
  @IsInt()
  delegateId!: number;

  @IsOptional()
  @Transform(emptyToNull)
  @Type(() => Number)
  @IsInt()
  companyId?: number | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsEnum(FinancialRequestType)
  requestType?: FinancialRequestType | null;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
