import { verify } from 'jsonwebtoken';
import type { Request } from 'express';

import { AuthUser } from '../type/auth-user.type';

/**
 * Đọc người dùng từ JWT nếu có, KHÔNG chặn khi thiếu/hỏng.
 *
 * Endpoint thử đồ ảo mở công khai nên không dùng được `JwtAuthGuard` (guard đó
 * ném 401 khi không có token). Nhưng vẫn cần biết ai đang gọi để: miễn giới
 * hạn IP cho nhân viên, gắn job vào đúng tài khoản, và cho vai trò quản lý xem
 * job của người khác.
 *
 * Token sai/hết hạn được coi như khách vãng lai — không ném lỗi, vì với luồng
 * công khai thì "không đăng nhập" là trạng thái hợp lệ.
 *
 * Giải mã bằng đúng `JWT_SECRET` mà `JwtStrategy` đang dùng nên không thể giả
 * mạo danh tính để né giới hạn hay xem job người khác.
 */
export function decodeOptionalUser(req: Request): AuthUser | null {
  // Guard đã chạy trước (route có JwtAuthGuard) thì dùng luôn kết quả của nó.
  if (req.user?.id) return req.user as AuthUser;

  const header = req.headers?.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  try {
    const payload = verify(token, secret) as Record<string, any>;
    if (!payload?.sub) return null;

    return {
      id: Number(payload.sub),
      roles: payload.roles ?? [],
      name: payload.name,
    };
  } catch {
    return null;
  }
}
