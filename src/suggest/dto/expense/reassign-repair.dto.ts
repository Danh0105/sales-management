import { Type } from 'class-transformer';
import { IsInt, IsPositive } from 'class-validator';

/** Giám đốc/Sales Admin chỉ định nhân viên kỹ thuật khác sau khi người trước từ chối nhận việc. */
export class ReassignRepairDto {
    @Type(() => Number)
    @IsInt()
    @IsPositive({ message: 'Vui lòng chọn nhân viên kỹ thuật' })
    assignedTechnicianId!: number;
}
