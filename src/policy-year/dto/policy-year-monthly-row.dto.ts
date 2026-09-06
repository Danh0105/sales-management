import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

export class PolicyYearMonthlyRowDto {
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    id?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    rowIndex?: number;

    @Type(() => Number)
    @IsNumber()
    subjectId!: number;

    @Matches(/^\d{4}-\d{2}$/, { message: 'month phải đúng định dạng YYYY-MM' })
    month!: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    studentCount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    unitPrice?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    monthsCount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    principalPolicyAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    cashPolicyAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    equipmentPolicyAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    paidCashAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    paidEquipmentAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    calculatedPolicyAmount?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    policyAfterTaxAmount?: number;

    @IsOptional()
    @IsString()
    note?: string;
}
