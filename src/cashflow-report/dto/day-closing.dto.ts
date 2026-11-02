import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Chốt quỹ: mặc định hôm nay (giờ VN). */
export class CloseDayDto {
  @IsOptional()
  @Matches(DATE, { message: 'date phải có dạng YYYY-MM-DD' })
  date?: string;
}

export class ReopenDayDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Nhập lý do mở lại ngày chốt' })
  @MaxLength(1000)
  reason!: string;
}

export class DayClosingRangeDto {
  @Matches(DATE, { message: 'from phải có dạng YYYY-MM-DD' })
  from!: string;

  @Matches(DATE, { message: 'to phải có dạng YYYY-MM-DD' })
  to!: string;
}
