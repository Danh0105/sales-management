import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class DirectorUpdatePolicyDto {
    @IsNotEmpty()
    @Type(() => Number)
    @IsNumber()
    employeeId!: number;

    @IsNotEmpty()
    data: any;

    @IsOptional()
    @IsString()
    note?: string;

    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Min(1)
    durationMonths?: number;
}
