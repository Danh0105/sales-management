import { IsNotEmpty, IsNumber } from 'class-validator';

export class CreateWardDto {
    @IsNotEmpty()
    name!: string;

    @IsNumber()
    province_id!: number;
}