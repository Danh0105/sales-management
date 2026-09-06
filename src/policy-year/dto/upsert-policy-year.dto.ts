import { Type } from 'class-transformer';
import {
    IsArray,
    IsEnum,
    IsInt,
    IsOptional,
    IsString,
    Matches,
    ValidateNested,
} from 'class-validator';

import { PolicyYearStatus } from '../policy-year.enum';
import { PolicyYearSubjectDto } from './policy-year-subject.dto';
import { PolicyYearMonthlyRowDto } from './policy-year-monthly-row.dto';
import { PolicyYearSummaryDto } from './policy-year-summary.dto';

export class UpsertPolicyYearDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    id?: number;

    @Type(() => Number)
    @IsInt({ message: 'schoolId là bắt buộc' })
    schoolId!: number;

    @IsOptional()
    @IsString()
    schoolName?: string;

    @Matches(/^\d{4}-\d{4}$/, { message: 'schoolYear phải đúng định dạng YYYY-YYYY' })
    schoolYear!: string;

    @IsOptional()
    @IsEnum(PolicyYearStatus, { message: 'status chỉ nhận DRAFT | ACTIVE | LOCKED' })
    status?: PolicyYearStatus;

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PolicyYearSubjectDto)
    subjects?: PolicyYearSubjectDto[];

    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PolicyYearMonthlyRowDto)
    monthlyRows?: PolicyYearMonthlyRowDto[];

    @IsOptional()
    @ValidateNested()
    @Type(() => PolicyYearSummaryDto)
    summary?: PolicyYearSummaryDto;
}
