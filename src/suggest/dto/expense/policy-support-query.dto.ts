import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, Matches } from 'class-validator';

/** Bảng hỗ trợ tiền mặt / thiết bị trong chính sách đã duyệt của một trường. */
export class PolicySupportQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  schoolId!: number;

  @Matches(/^\d{4}-\d{4}$/, { message: 'Năm học không hợp lệ' })
  schoolYear!: string;

  /** Đang sửa đề xuất của chính mình: phần của đề xuất đó không tính là đang giữ. */
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @IsPositive()
  excludeSuggestId?: number;
}
