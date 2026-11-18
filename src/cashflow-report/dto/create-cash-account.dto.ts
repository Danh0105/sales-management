import { OmitType } from '@nestjs/mapped-types';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { UpdateCashAccountDto } from './update-cash-account.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Thêm tài khoản tiền; nhóm 111/112 suy từ đầu mã. */
export class CreateCashAccountDto extends OmitType(UpdateCashAccountDto, [
  'name',
] as const) {
  @Transform(trim)
  @Matches(/^11[12]\d{1,17}$/, {
    message:
      'Mã tài khoản chỉ gồm chữ số, bắt đầu bằng 111 (tiền mặt) hoặc 112 (ngân hàng)',
  })
  code!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Nhập tên tài khoản' })
  @MaxLength(200)
  name!: string;
}
