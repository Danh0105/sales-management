import {
    IsEnum,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { toMoney } from '../../utils/money';
import { PaymentMethod } from '../../enums/expense-payment-method.enum';

export class CreatePaymentOrderDto {
    @Transform(toMoney)
    @IsNumber({}, { message: 'Số tiền không hợp lệ' })
    @IsPositive({ message: 'Số tiền phải lớn hơn 0' })
    amount!: number;

    /** CASH | BANK_TRANSFER */
    @IsEnum(PaymentMethod)
    paymentMethod!: PaymentMethod;

    // Nguồn tiền (fundSource) do Thủ quỹ chọn khi xác nhận xuất tiền, không
    // còn chọn ở bước lập lệnh chi — xem ConfirmCashReleasedDto.

    @IsOptional()
    @IsString()
    note?: string;
}
