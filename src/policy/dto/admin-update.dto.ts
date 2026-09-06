import { IsOptional, IsNumber, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { PolicyStatus } from '../policy.enum';

export class AdminUpdatePolicyDto {
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    status?: PolicyStatus;

    @IsOptional()
    @IsString()
    note?: string;

    @IsOptional()
    @IsNumber()
    subjectId?: number;

    @IsOptional()
    @IsNumber()
    userId!: number;

}