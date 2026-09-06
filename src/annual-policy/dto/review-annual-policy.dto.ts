import { IsEnum, IsOptional, IsString } from 'class-validator';
import { AnnualPolicyStatus } from '../annual-policy.enum';

export class ReviewAnnualPolicyDto {
    @IsEnum([AnnualPolicyStatus.APPROVED, AnnualPolicyStatus.REJECTED])
    status!: AnnualPolicyStatus.APPROVED | AnnualPolicyStatus.REJECTED;

    @IsOptional()
    @IsString()
    note?: string;
}
