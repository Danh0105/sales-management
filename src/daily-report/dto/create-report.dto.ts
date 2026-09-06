import { IsArray, IsDateString, IsNumber, IsOptional, IsString } from 'class-validator';

class TaskDto {
    @IsString()
    title?: string;

    @IsString()
    content?: string;

    @IsOptional()
    @IsString()
    location?: string;
}

export class CreateReportDto {
    @IsDateString()
    date?: string;


    @IsArray()
    tasks!: TaskDto[];

    @IsNumber()
    employeeId!: number;
}