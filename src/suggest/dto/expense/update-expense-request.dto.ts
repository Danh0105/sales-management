import { PartialType } from '@nestjs/mapped-types';

import { CreateExpenseRequestDto } from './create-expense-request.dto';

/**
 * Kinh doanh sửa đề xuất đã gửi duyệt. Mọi trường đều tuỳ chọn — trường bỏ
 * trống giữ nguyên giá trị cũ. Không cho đổi `requestKind`: đổi loại là đổi
 * cả nhánh xử lý (kế toán ↔ kỹ thuật), phải tạo đề xuất mới.
 */
export class UpdateExpenseRequestDto extends PartialType(
  CreateExpenseRequestDto,
) {}
