import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsDateString,
    IsInt,
    IsOptional,
    IsPositive,
    IsString,
    Matches,
    MaxLength,
    ValidateNested,
} from 'class-validator';

export class StockIssueItemDto {
    @IsString()
    @MaxLength(255)
    name!: string;

    /** Nếu chọn từ thiết bị có sẵn trong kho — kho sẽ tự trừ tồn khi lệnh được lập. */
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
    @IsString()
    note?: string;
}

export class CreateStockIssueOrderDto {
    @IsArray()
    @ArrayMinSize(1, { message: 'Lệnh xuất kho phải có ít nhất 1 thiết bị' })
    @ValidateNested({ each: true })
    @Type(() => StockIssueItemDto)
    items!: StockIssueItemDto[];

    @IsOptional()
    @IsString()
    @MaxLength(255)
    warehouse?: string;

    @IsOptional()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    @IsDateString()
    expectedDeliveryDate?: string;

    @IsOptional()
    @IsString()
    note?: string;
}
