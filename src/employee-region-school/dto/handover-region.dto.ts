import {
    IsArray,
    IsNumber,
    IsOptional,
} from 'class-validator';

export class HandoverRegionDto {

    @IsNumber()
    fromEmployeeId!: number;

    @IsNumber()
    toEmployeeId!: number;

    @IsOptional()
    @IsArray()
    provinceIds?: number[];

    @IsOptional()
    @IsArray()
    wardIds?: number[];
}