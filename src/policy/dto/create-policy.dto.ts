import { Type } from "class-transformer";
import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { PolicyStatus } from "../policy.enum";
export class EmployeeInfoDto {
    @IsNumber()
    sub!: number;

    @IsOptional()
    @IsString()
    name!: string;

    @IsOptional()
    @IsString()
    email!: string;
}
export class CreatePolicyDto {
    subjectId?: number;
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => EmployeeInfoDto)
    employeeInfo!: EmployeeInfoDto;
    data: any;
    @IsOptional()
    @IsString()
    status?: PolicyStatus;
    /** Cho phép số lẻ (8.5 tháng); chốt 2 chữ số thập phân đúng bằng cột DB. */
    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 2 })
    @Min(1)
    durationMonths?: number;
}
