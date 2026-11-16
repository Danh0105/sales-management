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
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
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

  /**
   * Chi Ngoài / Chi Trường / Chi GV trường chưa có kỳ: kinh doanh tạo kỳ theo
   * tháng (1–12) + năm cho trường đã chọn. Kỳ đã có thì trả lại kỳ đó.
   */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1, { message: 'Tháng không hợp lệ' })
  @Max(12, { message: 'Tháng không hợp lệ' })
  periodMonth?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(2020, { message: 'Năm không hợp lệ' })
  @Max(2100, { message: 'Năm không hợp lệ' })
  periodYear?: number;

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
