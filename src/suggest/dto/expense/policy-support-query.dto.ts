import { Type } from 'class-transformer';
import { IsInt, IsPositive, Matches } from 'class-validator';

/** Bảng hỗ trợ tiền mặt / thiết bị trong chính sách đã duyệt của một trường. */
export class PolicySupportQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  schoolId!: number;

  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear!: string;
}
