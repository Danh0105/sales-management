import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

/** Người bàn giao / người hỗ trợ từ chối việc được giao. */
export class DeclineAssignmentDto {
    @IsString()
    @IsNotEmpty({ message: 'Vui lòng nhập lý do từ chối' })
    reason!: string;
}

/** Giám đốc chọn người thay thế cho người đã từ chối. */
export class ReplaceAssignmentDto {
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    employeeId!: number;
}
