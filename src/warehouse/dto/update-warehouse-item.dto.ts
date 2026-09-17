import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateWarehouseItemDto {
    @IsOptional()
    @IsString()
    @MaxLength(255)
    name?: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    unit?: string;

    /** Số IMEI — không bắt buộc. */
    @IsOptional()
    @IsString()
    @MaxLength(50)
    imei?: string;

    @IsOptional()
    @IsString()
    note?: string;
}
