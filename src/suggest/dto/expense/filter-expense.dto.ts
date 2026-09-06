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

export class FilterExpenseDto {
    @IsOptional()
    @IsEnum(SuggestStatus)
    status?: SuggestStatus;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    createdBy?: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    schoolId?: number;

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
