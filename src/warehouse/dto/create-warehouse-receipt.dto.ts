import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsEnum,
    IsInt,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
    MaxLength,
    Min,
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

    /** Số serial/IMEI của các thiết bị trong dòng (nhiều máy thì cách nhau dấu phẩy/xuống dòng). */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    serial?: string;

    /** Đơn giá nhập. */
    @IsOptional()
    @Type(() => Number)
    @IsNumber({}, { message: 'Đơn giá phải là số' })
    @Min(0, { message: 'Đơn giá không được âm' })
    unitPrice?: number;

    /** Ghi chú chi tiết cho dòng thiết bị (tình trạng, bảo hành, nhà cung cấp…). */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    note?: string;
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
