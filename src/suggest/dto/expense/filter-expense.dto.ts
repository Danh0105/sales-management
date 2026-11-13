import {
    IsBoolean,
    IsDateString,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { SuggestStatus } from '../../SuggestStatus.enum';
import { ExpenseRequestKind } from '../../enums/expense-request-kind.enum';

export class FilterExpenseDto {
    @IsOptional()
    @IsEnum(SuggestStatus)
    status?: SuggestStatus;

    /** Lọc theo loại đề xuất: tiền hay thiết bị */
    @IsOptional()
    @IsEnum(ExpenseRequestKind)
    requestKind?: ExpenseRequestKind;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    createdBy?: number;

    /**
     * Đi kèm `createdBy` = chính người đang xem: trả thêm các đề xuất người đó
     * được Giám đốc chỉ định (bàn giao, hỗ trợ, xử lý nhập kho, nghiệm thu).
     */
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    includeAssigned?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    schoolId?: number;

    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    isMonthlyExpense?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    subjectId?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    expensePeriodId?: number;

    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
    schoolYear?: string;

    /** Lọc theo expectedPaymentDate >= fromDate */
    @IsOptional()
    @IsDateString()
    fromDate?: string;

    /** Lọc theo expectedPaymentDate <= toDate */
    @IsOptional()
    @IsDateString()
    toDate?: string;

    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    overdue?: boolean;

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
