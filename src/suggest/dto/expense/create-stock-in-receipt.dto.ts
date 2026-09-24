import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsInt,
    IsOptional,
    IsPositive,
    IsString,
    Min,
    MaxLength,
    ValidateNested,
} from 'class-validator';

export class StockInItemDto {
    @IsString()
    @MaxLength(255)
    name!: string;

    /** Thiết bị đã có mã trong kho; để trống = tạo thiết bị mới khi nhập kho. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    warehouseItemId?: number;

    @Type(() => Number)
    @IsInt({ message: 'Số lượng phải là số nguyên' })
    @IsPositive({ message: 'Số lượng phải lớn hơn 0' })
    quantity!: number;

    @IsOptional()
    @IsString()
    @MaxLength(50)
    unit?: string;

    @IsOptional()
    @Type(() => Number)
    @Min(0, { message: 'Đơn giá không được âm' })
    unitPrice?: number;

    @IsOptional()
    @IsString()
    note?: string;
}

/** Người xử lý lập phiếu nhập kho thật cho đề xuất thiết bị mới. */
export class CreateStockInReceiptDto {
    @IsArray()
    @ArrayMinSize(1, { message: 'Phiếu nhập kho phải có ít nhất 1 thiết bị' })
    @ValidateNested({ each: true })
    @Type(() => StockInItemDto)
    items!: StockInItemDto[];

    @IsOptional()
    @IsString()
    note?: string;
}
