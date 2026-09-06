import { IsOptional, IsString, MaxLength } from 'class-validator';

export class WithdrawExpenseDto {
    /**
     * Lý do rút — tuỳ chọn. Khác với `reject` (bắt buộc có lý do): giám đốc từ
     * chối thì người tạo cần biết vì sao, còn người tạo tự rút đơn của mình thì
     * không nợ ai lời giải thích.
     */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    reason?: string;
}
