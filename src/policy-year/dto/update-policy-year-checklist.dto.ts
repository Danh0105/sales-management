import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Matches } from 'class-validator';

export class UpdatePolicyYearChecklistDto {
    @Type(() => Number)
    @IsInt({ message: 'schoolId là bắt buộc' })
    schoolId!: number;

    @Matches(/^\d{4}-\d{4}$/, { message: 'schoolYear phải đúng định dạng YYYY-YYYY' })
    schoolYear!: string;

    @IsOptional()
    @IsBoolean()
    giftFlowersCompleted?: boolean;

    @IsOptional()
    @IsBoolean()
    openingCeremonyCompleted?: boolean;

    @IsOptional()
    @IsBoolean()
    teachersDayCompleted?: boolean;
}
