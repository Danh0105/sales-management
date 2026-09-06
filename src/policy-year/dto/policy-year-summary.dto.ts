import { Type } from 'class-transformer';
import { IsNumber, IsOptional } from 'class-validator';

/** Summary FE tính sẵn — BE lưu raw để đối chiếu/báo cáo. */
export class PolicyYearSummaryDto {
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalStudents?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalRevenue?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalTkd?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalSchoolRetain?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalCompanyPayment?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalInitialPolicy?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalPolicyAfterTax?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalPaid?: number;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    totalRemaining?: number;
}
