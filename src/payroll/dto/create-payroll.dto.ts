import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const OPTIONAL_NUMBER_FIELDS = [
  'standardWorkingDays',
  'probationWorkingDays',
  'officialWorkingDays',
  'annualLeaveDays',
  'holidayDays',
  'unpaidLeaveDays',
  'excessPeriods',
  'remainingLeavePreviousYear',
  'remainingLeaveCurrentYear',
  'baseSalary',
  'officialWorkSalary',
  'probationWorkSalary',
  'fuelAllowance',
  'overtimeAllowance',
  'excessPeriodAllowance',
  'otherSupport',
  'bonus',
  'socialInsurance',
  'personalIncomeTax',
  'advancePayment',
] as const;

/** Decorators dùng chung cho mọi số ngày/tiền không âm. */
function OptionalNonNegativeNumber(): PropertyDecorator {
  return (target, propertyKey) => {
    IsOptional()(target, propertyKey);
    Type(() => Number)(target, propertyKey);
    IsNumber({ maxDecimalPlaces: 2 })(target, propertyKey);
    Min(0)(target, propertyKey);
  };
}

export class CreatePayrollDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  jobTitle?: string;

  @OptionalNonNegativeNumber()
  standardWorkingDays?: number;

  @OptionalNonNegativeNumber()
  probationWorkingDays?: number;

  @OptionalNonNegativeNumber()
  officialWorkingDays?: number;

  @OptionalNonNegativeNumber()
  annualLeaveDays?: number;

  @OptionalNonNegativeNumber()
  holidayDays?: number;

  @OptionalNonNegativeNumber()
  unpaidLeaveDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  leaveNote?: string;

  @OptionalNonNegativeNumber()
  excessPeriods?: number;

  @OptionalNonNegativeNumber()
  remainingLeavePreviousYear?: number;

  @OptionalNonNegativeNumber()
  remainingLeaveCurrentYear?: number;

  @OptionalNonNegativeNumber()
  baseSalary?: number;

  @OptionalNonNegativeNumber()
  officialWorkSalary?: number;

  @OptionalNonNegativeNumber()
  probationWorkSalary?: number;

  @OptionalNonNegativeNumber()
  fuelAllowance?: number;

  @OptionalNonNegativeNumber()
  overtimeAllowance?: number;

  @OptionalNonNegativeNumber()
  excessPeriodAllowance?: number;

  @OptionalNonNegativeNumber()
  otherSupport?: number;

  @OptionalNonNegativeNumber()
  bonus?: number;

  @OptionalNonNegativeNumber()
  socialInsurance?: number;

  @OptionalNonNegativeNumber()
  personalIncomeTax?: number;

  /** Số dương = khấu trừ, số âm = truy lãnh thêm cho nhân viên. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  adjustmentAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adjustmentNote?: string;

  @OptionalNonNegativeNumber()
  advancePayment?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

// Compile-time guard: khi thêm field số vào danh sách này mà quên khai trong
// DTO, TypeScript sẽ báo lỗi thay vì để dữ liệu bị ValidationPipe loại bỏ.
void (OPTIONAL_NUMBER_FIELDS satisfies readonly (keyof CreatePayrollDto)[]);
