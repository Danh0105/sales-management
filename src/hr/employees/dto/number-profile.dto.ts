import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { SENSITIVE_MAX_INPUT } from './common';

export class CreateTaxProfileDto {
  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  taxNumber: string;
}

export class UpdateTaxProfileDto extends CreateTaxProfileDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}

export class CreateInsuranceProfileDto {
  @IsString()
  @MaxLength(SENSITIVE_MAX_INPUT)
  socialInsuranceNumber: string;
}

export class UpdateInsuranceProfileDto extends CreateInsuranceProfileDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version: number;
}
