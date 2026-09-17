import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsEnum,
    IsInt,
    IsOptional,
    IsPositive,
    IsString,
    ValidateNested,
} from 'class-validator';

import { WarehouseReceiptType } from '../entities/warehouse-receipt.entity';

export class WarehouseReceiptItemDto {
    @Type(() => Number)
    @IsInt()
    warehouseItemId!: number;

    @Type(() => Number)
    @IsInt({ message: 'Số lượng phải là số nguyên' })
    @IsPositive({ message: 'Số lượng phải lớn hơn 0' })
    quantity!: number;
}

export class CreateWarehouseReceiptDto {
    @IsEnum(WarehouseReceiptType)
    type!: WarehouseReceiptType;

    @IsArray()
    @ArrayMinSize(1, { message: 'Phiếu phải có ít nhất 1 thiết bị' })
    @ValidateNested({ each: true })
    @Type(() => WarehouseReceiptItemDto)
    items!: WarehouseReceiptItemDto[];

    @IsOptional()
    @IsString()
    note?: string;
}
