import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';

export class SaleAdminReviewExpenseDto {
    /** REVIEWED = kiểm duyệt đạt | REJECTED = từ chối chính sách */
    @IsIn(['REVIEWED', 'REJECTED'])
    status!: 'REVIEWED' | 'REJECTED';

    /**
     * Ghi chú của Sales Admin — bắt buộc khi từ chối chính sách (REJECTED),
     * tuỳ chọn khi kiểm duyệt đạt (REVIEWED).
     */
    @ValidateIf((o) => o.status === 'REJECTED' || o.note !== undefined)
    @IsString()
    @IsNotEmpty({ message: 'Phải có ghi chú khi từ chối chính sách' })
    note?: string;
}
