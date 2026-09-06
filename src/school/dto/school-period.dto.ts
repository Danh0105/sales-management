import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** "07:00" hoặc "07:00:00" — cùng quy ước với giờ của mẫu lịch dạy. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export class SchoolPeriodItemDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30, { message: 'Số thứ tự dòng tối đa là 30' })
  periodNo!: number;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'Giờ bắt đầu phải dạng HH:mm' })
  startTime!: string;

  @IsString()
  @Matches(TIME_PATTERN, { message: 'Giờ kết thúc phải dạng HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string | null;

  /** Cột BUỔI của lưới TKB. */
  @IsOptional()
  @IsIn(['SANG', 'CHIEU'], { message: 'Buổi phải là SANG hoặc CHIEU' })
  session?: 'SANG' | 'CHIEU';

  /** `false` = dòng giờ ra chơi (không xếp lịch dạy vào được). */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isPeriod?: boolean;
}

/**
 * Ghi ĐÈ toàn bộ bảng tiết của một trường trong một lần gọi.
 *
 * Chọn kiểu thay-cả-bảng thay vì thêm/sửa/xoá từng tiết: người dùng khai bảng
 * tiết như một khối (thêm dòng, sửa giờ, xoá dòng rồi bấm Lưu), làm từng
 * endpoint riêng sẽ phải tự đồng bộ trạng thái ở FE và dễ lệch giữa chừng.
 */
export class ReplaceSchoolPeriodsDto {
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(30, { message: 'Tối đa 30 dòng tiết mỗi trường' })
  @ValidateNested({ each: true })
  @Type(() => SchoolPeriodItemDto)
  periods!: SchoolPeriodItemDto[];
}
