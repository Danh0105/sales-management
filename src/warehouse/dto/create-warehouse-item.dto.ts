import { Type } from 'class-transformer';
import {
    IsInt,
    IsOptional,
    IsPositive,
    IsString,
    Min,
    MaxLength,
} from 'class-validator';

export class CreateWarehouseItemDto {
    @IsString()
    @MaxLength(255)
    name!: string;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    unit?: string;

    /** Số IMEI — không bắt buộc. */
    @IsOptional()
    @IsString()
    @MaxLength(50)
    imei?: string;

    /** Số lượng tồn ban đầu — nếu > 0 sẽ tự tạo kèm 1 phiếu nhập kho. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    initialQuantity?: number;

    @IsOptional()
    @IsString()
    note?: string;
}
