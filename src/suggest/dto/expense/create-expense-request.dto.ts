import {
  ClassConstructor,
  plainToInstance,
  Transform,
  Type,
} from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CASHFLOW_SOURCES, type CashflowSource } from '../../cashflow-sources';

/** Endpoint gửi multipart/form-data (kèm file) nên `items` tới dưới dạng chuỗi JSON. */
export const parseJsonArray = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * Như `parseJsonArray` nhưng đổi từng phần tử thành instance của DTO. Cần vì
 * `@Type` chạy TRƯỚC `@Transform`: chuỗi JSON parse xong chỉ là object thường,
 * `whitelist` sẽ xoá sạch thuộc tính của chúng.
 */
export const parseJsonArrayOf =
  <T>(cls: ClassConstructor<T>) =>
  ({ value }: { value: unknown }) => {
    const parsed = parseJsonArray({ value });
    return Array.isArray(parsed)
      ? parsed.map((item) =>
          item && typeof item === 'object' ? plainToInstance(cls, item) : item,
        )
      : parsed;
  };

/** Endpoint gửi multipart/form-data nên boolean tới dưới dạng chuỗi "true"/"false". */
export const parseBoolean = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class RequestedEquipmentItemDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @Type(() => Number)
  @IsInt({ message: 'Số lượng phải là số nguyên' })
  @IsPositive({ message: 'Số lượng phải lớn hơn 0' })
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  /** Chọn từ thiết bị có sẵn trong kho — bỏ trống nếu cần mua mới. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  warehouseItemId?: number;
}

/** Tối đa số khoản của một "Đề xuất chi tháng" tích chọn (một trường + một kỳ). */
export const MAX_SALES_PICK_ITEMS = 200;

/**
 * Một khoản kinh doanh tích ở "Đề xuất chi tháng" (trường + kỳ lấy từ đề
 * xuất): Chi trường (SCHOOL_EXPENSE) / Chi Ban quản lí (MANAGEMENT) theo môn,
 * Chi giáo viên (SCHOOL_TEACHER) theo giáo viên trường.
 */
export class MonthlyCashflowItemDto {
  @IsIn(CASHFLOW_SOURCES as unknown as string[], {
    message: 'Loại khoản chi tháng không hợp lệ',
  })
  source!: CashflowSource;

  @ValidateIf((item: MonthlyCashflowItemDto) => item.source !== 'SCHOOL_TEACHER')
  @Type(() => Number)
  @IsInt({ message: 'Khoản Chi trường / Chi Ban quản lí phải có môn' })
  @IsPositive()
  subjectId?: number;

  @ValidateIf((item: MonthlyCashflowItemDto) => item.source === 'SCHOOL_TEACHER')
  @Type(() => Number)
  @IsInt({ message: 'Khoản Chi giáo viên phải có giáo viên' })
  @IsPositive()
  schoolTeacherId?: number;
}

/** Một trường của đề xuất chi tháng: trường + năm học + môn + kỳ kế toán. */
export class MonthlyExpenseItemDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  schoolId!: number;

  /** Bỏ trống thì server tự điền năm học hiện tại. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear?: string;

  /** Bắt buộc với Chi Ngoài / Chi Trường (khoản theo môn); Chi GV trường (có giáo viên) để trống. */
  @Type(() => Number)
  @ValidateIf((item: MonthlyExpenseItemDto) => !item.schoolTeacherId)
  @IsInt()
  @IsPositive()
  subjectId?: number;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  expensePeriodId!: number;

  /** Chỉ Đề xuất Chi GV trường: giáo viên của trường (khoản = lương giáo viên trong kỳ). */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  schoolTeacherId?: number;
}

/**
 * Đề xuất chi Năm cho trường: một dòng hỗ trợ tiền mặt / thiết bị trong chính
 * sách đã duyệt mà kinh doanh tích, kèm số tiền đề xuất (≤ phần còn lại).
 */
export class PolicySupportItemDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  policyId!: number;

  @IsIn(['CASH', 'EQUIPMENT'], { message: 'Loại dòng chính sách không hợp lệ' })
  supportType!: 'CASH' | 'EQUIPMENT';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  itemIndex!: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'Số tiền không hợp lệ' })
  @IsPositive({ message: 'Số tiền phải lớn hơn 0' })
  amount!: number;
}

export const MAX_POLICY_SUPPORT_ITEMS = 100;

export const MAX_MONTHLY_EXPENSE_ITEMS = 50;

export class CreateExpenseRequestDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  participants?: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString()
  expectedPaymentDate!: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  schoolId?: number;

  /**
   * Đề xuất chi tháng gắn với một môn và một kỳ kế toán cụ thể.
   * Nếu FE gửi subjectId/expensePeriodId thì server cũng tự nhận diện đây là
   * đề xuất chi tháng để tương thích với client chưa gửi cờ này.
   */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isMonthlyExpense?: boolean;

  /**
   * Bảng nguồn của đề xuất chi tháng: MANAGEMENT (Chi Ngoài — mặc định, client
   * cũ không gửi), SCHOOL_EXPENSE (Chi Trường), SCHOOL_TEACHER (Giáo viên trường).
   */
  @IsOptional()
  @IsIn(CASHFLOW_SOURCES as unknown as string[], {
    message: 'Loại đề xuất chi tháng không hợp lệ',
  })
  cashflowSource?: CashflowSource;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  subjectId?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  expensePeriodId?: number;

  /** Không bắt buộc — bỏ trống thì server tự điền năm học hiện tại. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear?: string;

  /**
   * Đề xuất chi tháng gồm nhiều trường. Multipart gửi chuỗi JSON. Client cũ
   * gửi một trường qua `schoolId/subjectId/expensePeriodId` vẫn được nhận.
   */
  @IsOptional()
  @Transform(({ value }) => parseJsonArrayOf(MonthlyExpenseItemDto)({ value }))
  @IsArray()
  @ArrayMinSize(1, { message: 'Đề xuất chi tháng phải chọn ít nhất một trường' })
  @ArrayMaxSize(MAX_MONTHLY_EXPENSE_ITEMS, {
    message: `Một đề xuất chi tháng tối đa ${MAX_MONTHLY_EXPENSE_ITEMS} trường`,
  })
  @ValidateNested({ each: true })
  monthlyItems?: MonthlyExpenseItemDto[];

  /**
   * "Đề xuất chi tháng" tích chọn (19/11/2026): các khoản kinh doanh chọn ở
   * bảng Chi Trường / Chi Ngoài / Giáo viên trường của `schoolId` trong kỳ
   * `expensePeriodId`. Multipart gửi chuỗi JSON. Có trường này = luồng mới.
   */
  @IsOptional()
  @Transform(({ value }) => parseJsonArrayOf(MonthlyCashflowItemDto)({ value }))
  @IsArray()
  @ArrayMinSize(1, { message: 'Chọn ít nhất một khoản chi' })
  @ArrayMaxSize(MAX_SALES_PICK_ITEMS, {
    message: `Một đề xuất chi tháng tối đa ${MAX_SALES_PICK_ITEMS} khoản`,
  })
  @ValidateNested({ each: true })
  cashflowItems?: MonthlyCashflowItemDto[];

  /** Số tiền kinh doanh đề xuất — không vượt tổng Còn chi các khoản đã chọn. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Số tiền đề xuất không hợp lệ' })
  @IsPositive({ message: 'Số tiền đề xuất phải lớn hơn 0' })
  salesAmount?: number;

  /** Đề xuất chi Năm cho trường: dòng hỗ trợ đã tích (multipart gửi chuỗi JSON). */
  @IsOptional()
  @Transform(({ value }) => parseJsonArrayOf(PolicySupportItemDto)({ value }))
  @IsArray()
  @ArrayMaxSize(MAX_POLICY_SUPPORT_ITEMS, {
    message: `Tối đa ${MAX_POLICY_SUPPORT_ITEMS} dòng chính sách`,
  })
  @ValidateNested({ each: true })
  policySupportItems?: PolicySupportItemDto[];

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  wardId?: number;

  /** Giữ tương thích với client cũ của module đề xuất chi. */
  @IsOptional()
  @IsString()
  beneficiaryInfo?: string;

  /**
   * Kinh doanh tự đánh dấu: đề xuất này nên trừ vào chính sách liên quan.
   * Chỉ để hiển thị/thống kê, không có logic trừ tiền tự động kèm theo.
   */
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  deductPolicy?: boolean;
}
