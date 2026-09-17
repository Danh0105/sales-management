import { IsEnum, IsOptional, IsString } from 'class-validator';

import { FundSource } from '../../enums/expense-fund-source.enum';

/** Thủ quỹ xác nhận đã xuất tiền — chọn nguồn tiền đã dùng để chi. */
export class ConfirmCashReleasedDto {
    /** COMPANY_CASH (tiền sẵn có ở công ty) | BANK_ACCOUNT (tài khoản ngân hàng) */
    @IsEnum(FundSource, { message: 'Nguồn tiền không hợp lệ' })
    fundSource!: FundSource;

    @IsOptional()
    @IsString()
    note?: string;
}
