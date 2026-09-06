import {
    IsDateString,
    IsInt,
    IsOptional,
    IsString,
    IsArray,
    ValidateNested,
    Min,
    Max,
} from 'class-validator';

import { Type } from 'class-transformer';

/**
 * Employee info
 */
export class EmployeeInfoDto {
    @IsInt()
    sub!: number;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString()
    email?: string;
}

/**
 * DTO cho từng task trong tuần
 */
export class WeeklyPlanTaskDto {
    @IsString()
    title?: string;

    @IsOptional()
    @IsString()
    content?: string;

    @IsOptional()
    @IsString()
    location?: string;

    @IsInt()
    @Min(1)
    @Max(7)
    dayOfWeek?: number;
}

/**
 * DTO tạo kế hoạch tuần
 */
export class CreateWeeklyPlanDto {
    @IsDateString()
    startDate?: string;

    @IsDateString()
    endDate?: string;

    @IsOptional()
    @IsInt()
    employeeId?: number;

    @IsOptional()
    @IsString()
    status?: string;

    // ✅ thêm employeeInfo
    @ValidateNested()
    @Type(() => EmployeeInfoDto)
    employeeInfo?: EmployeeInfoDto;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => WeeklyPlanTaskDto)
    tasks?: WeeklyPlanTaskDto[];
}