import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';

/**
 * Các vai trò CHỈ XEM — không được phép thao tác ghi ở bất kỳ đâu.
 * Thêm slug mới vào đây nếu có thêm vai trò read-only.
 */
export const READ_ONLY_ROLES = ['ketoan_truong'];

/**
 * Chặn các vai trò chỉ-xem khỏi endpoint ghi mà KHÔNG cần allow-list —
 * người dùng ghi hiện tại không bị ảnh hưởng. Chỉ chặn khi TẤT CẢ vai trò
 * của user đều là read-only (user vừa có role ghi vừa có read-only vẫn qua).
 *
 * Yêu cầu JwtAuthGuard chạy trước để có req.user. Nếu không có user
 * (endpoint mở, chưa đăng nhập) thì guard không chặn — giữ nguyên hành vi cũ.
 */
@Injectable()
export class BlockReadOnlyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest();
        const roles: string[] = req.user?.roles ?? [];

        const isReadOnly =
            roles.length > 0 && roles.every((r) => READ_ONLY_ROLES.includes(r));

        if (isReadOnly) {
            throw new ForbiddenException('Bạn chỉ có quyền xem');
        }

        return true;
    }
}
