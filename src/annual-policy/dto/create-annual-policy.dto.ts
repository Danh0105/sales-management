import { Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';

export class CreateAnnualPolicyDto {
    @IsNotEmpty()
    @Type(() => Number)
    @IsNumber()
    schoolId!: number;

    @IsNotEmpty()
    @IsString()
    schoolYear!: string;

    @IsNotEmpty()
    @Type(() => Number)
    @IsNumber()
    @Min(0)
    amount!: number;

    @IsNotEmpty()
    @IsString()
    content!: string;
}
