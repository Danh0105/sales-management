// dto/policy-stats.dto.ts
import { Transform } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional } from 'class-validator';

export class PolicyStatsDto {
    @IsNumber()
    employeeId!: number;

    /**
     * Mặc định chỉ trả chính sách đã được giám đốc duyệt (dùng cho các trang
     * thống kê doanh thu). Bật cờ này để lấy chính sách ở mọi trạng thái —
     * dùng cho màn "Tất cả chính sách" của giám đốc.
     */
    @IsOptional()
    @Transform(({ value }) => value === 'true' || value === true)
    @IsBoolean()
    allStatuses?: boolean;
}