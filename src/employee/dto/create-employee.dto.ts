// create-employee.dto.ts
import { Transform } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsNumber,
  IsArray,
  MinLength,
  MaxLength,
} from 'class-validator';

const toNullableTrimmedString = ({ value }: { value: unknown }) => {
  if (value === null) return null;
  if (typeof value !== 'string') return value;
  return value.trim() || null;
};

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
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(50)
  bankAccountNumber?: string | null;

  @IsOptional()
  @Transform(toNullableTrimmedString)
  @IsString()
  @MaxLength(255)
  bankName?: string | null;

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
