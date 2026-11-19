import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';

import { INVOICE_CASH_ACCOUNT_CODES } from '../../../revenue-item/invoice-cash-account';
import { FundSource } from '../../enums/expense-fund-source.enum';
import { parseJsonArray } from './create-expense-request.dto';

/** Thủ quỹ xác nhận đã xuất tiền — chọn nguồn chi đã dùng để chi. */
export class ConfirmCashReleasedDto {
    /**
     * Nguồn chi: số hiệu tài khoản trong danh mục Nguồn thu chi (vd "1121").
     * Có thì `fundSource` suy ra từ tài khoản (111x tiền mặt, 112x ngân hàng).
     */
    @IsOptional()
    @IsIn(INVOICE_CASH_ACCOUNT_CODES, { message: 'Nguồn chi không hợp lệ' })
    cashAccount?: string;

    /** Client cũ chỉ gửi nhóm: COMPANY_CASH (tiền sẵn có ở công ty) | BANK_ACCOUNT (tài khoản ngân hàng) */
    @IsOptional()
    @IsEnum(FundSource, { message: 'Nguồn tiền không hợp lệ' })
    fundSource?: FundSource;

    /**
     * Nhiều nguồn chi (19/11/2026): `[{ cashAccount, amount }]`, tổng = đúng số
     * lệnh chi. Gửi multipart nên tới dạng chuỗi JSON; kiểm chi tiết ở service.
     */
    @IsOptional()
    @Transform(parseJsonArray)
    @IsArray({ message: 'Nguồn chi không hợp lệ' })
    @ArrayMaxSize(10, { message: 'Tối đa 10 nguồn chi' })
    cashSplits?: { cashAccount: string; amount: number }[];

    @IsOptional()
    @IsString()
    note?: string;
}
