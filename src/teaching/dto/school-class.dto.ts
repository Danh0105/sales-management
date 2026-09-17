import { OmitType, PartialType } from '@nestjs/mapped-types';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsArray,
    ArrayUnique,
    MaxLength,
    Max,
    Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value;

const toBool = ({ value }: { value: unknown }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
};

export class CreateSchoolClassDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolLocationId?: number | null;

    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Tên lớp không được để trống' })
    @MaxLength(100)
    name!: string;

    /** "2026-2027", "Hè 2026-2027" — cùng quy ước với môn học của trường. */
    @Transform(trim)
    @IsString()
    @IsNotEmpty({ message: 'Năm học không được để trống' })
    @MaxLength(20)
    schoolYear!: string;

    /** Một lớp có thể học nhiều môn; dùng ID môn của chính trường đã chọn. */
    @IsOptional()
    @IsArray()
    @ArrayUnique()
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    subjectIds?: number[];

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    gradeLevel?: number | null;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    @Max(1000)
    studentCount?: number;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(255)
    homeroomTeacher?: string;

    @IsOptional()
    @Transform(toBool)
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(1000)
    note?: string;
}

/** `schoolId` bị loại bỏ: đổi trường của lớp sẽ làm lịch dạy đã sinh trỏ sai trường. */
export class UpdateSchoolClassDto extends PartialType(
    OmitType(CreateSchoolClassDto, ['schoolId'] as const),
) {}

export class QuerySchoolClassesDto {
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId?: number;

    /**
     * Chỉ lớp của một điểm trường (cơ sở) — trường nhiều cơ sở có lớp riêng từng nơi.
     * Truyền `0` = chỉ lớp của TRƯỜNG CHÍNH (chưa gắn điểm trường nào): trường
     * chính và mỗi điểm trường là các phạm vi lớp tách biệt, không trộn chung.
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    schoolLocationId?: number;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(100)
    search?: string;

    @IsOptional()
    @Transform(trim)
    @IsString()
    @MaxLength(20)
    schoolYear?: string;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    gradeLevel?: number;

    /**
     * Môn trong danh mục dùng chung. Có tham số này thì mỗi lớp được trả kèm
     * môn tương ứng của trường (`subjectId` / `subjectName` / `subjectStatus`)
     * để Nhân sự thấy trước lớp nào áp được môn, lớp nào trường chưa khai.
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    catalogId?: number;

    @IsOptional()
    @Transform(toBool)
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number = 50;
}
