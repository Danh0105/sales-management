import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString } from 'class-validator';

export class PolicyYearSubjectDto {
    /** = subjects[].id FE gửi (định danh môn, monthlyRows liên kết qua giá trị này). */
    @Type(() => Number)
    @IsNumber()
    id!: number;

    @IsOptional()
    @IsString()
    code?: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    tuitionPrice?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    schoolRetainUnit?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    policyTotalAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    policyStudentBase?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    policyMonthBase?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    taxPercent?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    companyProfitPerHS?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    cashSupportAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    equipmentSupportAmount?: number;
}
