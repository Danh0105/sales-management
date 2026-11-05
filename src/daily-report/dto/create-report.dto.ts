import { IsArray, IsDateString, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

class TaskDto {
    @IsString()
    title?: string;

    @IsString()
    content?: string;

    @IsOptional()
    @IsString()
    location?: string;

    @IsOptional()
    @IsInt()
    @Min(1)
    schoolId?: number | null;
}

export class CreateReportDto {
    @IsDateString()
    date?: string;


    @IsArray()
    tasks!: TaskDto[];

    @IsNumber()
    employeeId!: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    schoolId?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    provinceId?: number | null;
}
