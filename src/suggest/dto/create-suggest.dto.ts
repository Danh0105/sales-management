// dto/create-suggest.dto.ts
import { IsArray, IsBoolean, IsOptional, IsString, IsDateString, IsEnum, IsNumber, IsInt, Min, MaxLength, Matches, ValidateNested, ArrayMinSize } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { SuggestStatus } from '../SuggestStatus.enum';
import { SuggestType } from '../enums/suggest-type.enum';
import { ExpenseRequestKind } from '../enums/expense-request-kind.enum';
import { toMoney } from '../utils/money';
import { RequestedEquipmentItemDto, parseJsonArray, parseBoolean } from './expense/create-expense-request.dto';

export class CreateSuggestDto {
    @IsString()
    content?: string;

    @IsOptional()
    @IsString()
    component?: string;

    @IsOptional()
    @IsString()
    description?: string;

    @IsOptional()
    @IsDateString()
    issueDate?: string;

    policyId?: number | null;

    /** Được endpoint /suggest/wards/:wardId gán từ URL, không cần FE gửi. */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    wardId?: number;

    @IsOptional()
    @IsEnum(SuggestStatus)
    status?: SuggestStatus;

    @IsOptional()
    // Tài khoản nhiều role có thể vẫn đi qua endpoint `/suggest` tương thích
    // cũ. Chuẩn hoá tiền giống `/expense-requests`, tránh Number('1.000.000')
    // thành NaN khi frontend gửi multipart/form-data theo định dạng Việt Nam.
    @Transform(toMoney)
    @IsNumber()
    @Min(0)
    amount?: number;

    // ===== chỉ dùng khi tạo ĐỀ XUẤT CHI (type = EXPENSE_REQUEST) =====

    /** Phân loại luồng; bỏ trống = SUGGESTION (luồng cũ) */
    @IsOptional()
    @IsEnum(SuggestType)
    type?: SuggestType;

    /** Loại đề xuất chi: CASH (mặc định) | EQUIPMENT */
    @IsOptional()
    @IsEnum(ExpenseRequestKind)
    requestKind?: ExpenseRequestKind;

    /** Ngày dự kiến chi (YYYY-MM-DD) — bắt buộc khi type = EXPENSE_REQUEST */
    @IsOptional()
    @IsDateString()
    expectedPaymentDate?: string;

    /** Thông tin người thụ hưởng */
    @IsOptional()
    @IsString()
    beneficiaryInfo?: string;

    /** Thành phần tham gia */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    participants?: string;

    /**
     * Kinh doanh tự đánh dấu: đề xuất này nên trừ vào chính sách liên quan.
     * Chỉ để hiển thị/thống kê, không có logic trừ tiền tự động kèm theo.
     */
    @IsOptional()
    @Transform(parseBoolean)
    @IsBoolean()
    deductPolicy?: boolean;

    /** Trường liên quan (multipart gửi string → ép Number) */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    schoolId?: number;

    /** Năm học liên quan; bắt buộc ở endpoint expense-requests */
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
    schoolYear?: string;

    /** Danh sách thiết bị mong muốn — chỉ áp dụng khi `requestKind = EQUIPMENT`. */
    @IsOptional()
    @Transform(parseJsonArray)
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => RequestedEquipmentItemDto)
    items?: RequestedEquipmentItemDto[];
}
