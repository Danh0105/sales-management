// create-employee.dto.ts
import {
    IsString,
    IsOptional,
    IsEmail,
    IsNumber,
    IsArray,
    MinLength,
} from 'class-validator';

export class CreateEmployeeDto {
    @IsString()
    name!: string;

    @IsOptional()
    @IsEmail()
    email?: string;

    @IsOptional()
    @IsString()
    phone?: string;

    @IsOptional()
    @MinLength(6)
    password?: string;

    @IsOptional()
    @IsNumber()
    departmentId?: number;

    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    roles?: string[];

    @IsOptional()
    @IsString()
    role?: string;

}