import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Bộ lọc chung của báo cáo. Tháng / quý / năm do giao diện quy đổi ra
 * from–to, backend chỉ nhận khoảng ngày (tính cả hai đầu, giờ Việt Nam).
 */
export class CashflowQueryDto {
  @Matches(DATE_RE, { message: 'from phải có dạng YYYY-MM-DD' })
  from!: string;

  @Matches(DATE_RE, { message: 'to phải có dạng YYYY-MM-DD' })
  to!: string;

  /** all = cả tiền mặt và ngân hàng. */
  @IsOptional()
  @IsIn(['all', 'cash', 'bank'])
  accountType?: 'all' | 'cash' | 'bank';

  @IsOptional()
  @IsString()
  @MaxLength(20)
  accountCode?: string;

  /** Số chứng từ, số hóa đơn, diễn giải, mã/tên đối tượng (không phân biệt dấu). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** true = tổng thu chi loại trừ chuyển tiền nội bộ. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  excludeInternal?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
