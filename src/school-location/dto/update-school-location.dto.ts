import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateSchoolLocationDto } from './create-school-location.dto';

/**
 * Cập nhật điểm trường.
 * `schoolId` không thể đổi sau khi tạo (cùng lý do với SchoolClass.schoolId:
 * sẽ làm sai lệch lịch dạy/buổi học đã sinh từ điểm trường đó).
 */
export class UpdateSchoolLocationDto extends PartialType(
    OmitType(CreateSchoolLocationDto, ['schoolId']),
) {}
