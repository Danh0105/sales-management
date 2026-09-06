import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

/**
 * Phân khu vực cho một nhân viên.
 *
 * **Bắt buộc phải có decorator trên mọi field.** Controller `employees` bật
 * `ValidationPipe({ whitelist: true })`, mà whitelist loại bỏ đúng những
 * thuộc tính không có decorator validate. DTO này trước đây không có decorator
 * nào nên bị xoá sạch: `wardIds` thành `undefined`, service tra `In([])` không
 * ra ward nào, trả về `[]` kèm HTTP 201 — giao diện báo lưu thành công trong
 * khi bảng `employee_region` không có thêm dòng nào.
 */
export class AssignRegionDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    employeeId!: number;

    /**
     * Hiện `assignRegion` **không dùng** tới field này — khu vực được lưu theo
     * ward, và tỉnh suy ra từ ward. Giữ lại để không làm hỏng client đang gửi
     * kèm; whitelist sẽ không còn xoá nhầm các field khác nữa.
     */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    provinceIds?: number[];

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(500)
    @Type(() => Number)
    @IsInt({ each: true })
    @Min(1, { each: true })
    wardIds?: number[];
}
