import { IsArray, IsNumber } from "class-validator";

export class CreateFaceDto {
    @IsNumber()
    employeeId!: number;

    @IsArray()
    descriptor!: number[];
}