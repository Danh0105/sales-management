import { IsIn } from 'class-validator';
import { HR_PERMISSION_CODES, HrPermission } from '../../access/hr-permission';
import { HrGrantScopeFields } from './assign-hr-role.dto';

/**
 * Cấp MỘT quyền lẻ cho một tài khoản (Phase 1.3) — cùng trường phạm vi/thời
 * hạn/lý do và cùng luật với cấp role. ACCESS_ADMIN bị từ chối ở service.
 */
export class GrantHrPermissionDto extends HrGrantScopeFields {
  @IsIn(HR_PERMISSION_CODES, { message: 'permissionCode không hợp lệ' })
  permissionCode: HrPermission;
}
