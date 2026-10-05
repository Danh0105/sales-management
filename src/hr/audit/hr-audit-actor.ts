import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { AuthUser } from '../../type/auth-user.type';

/** Người thực hiện + bối cảnh request, chụp lại tại thời điểm thao tác. */
export interface HrAuditActor {
  /** null = hệ thống (cron, migration dữ liệu). */
  accountId: number | null;
  name?: string | null;
  roles?: string[];
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

interface RequestLike {
  user?: AuthUser;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
}

const LOOPBACK = ['127.0.0.1', '::1'];

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const trimmed = ip.trim().replace(/^::ffff:/, '');
  return isIP(trimmed) ? trimmed : null;
}

/**
 * IP thật của client.
 *
 * App không bật `trust proxy`, nên phía sau nginx `req.ip` luôn là 127.0.0.1.
 * Khi kết nối đến từ loopback (tức từ nginx), lấy phần tử CUỐI của
 * X-Forwarded-For: `proxy_add_x_forwarded_for` nối IP client vào cuối, còn
 * các phần tử phía trước do client tự gửi và có thể giả mạo. Kết nối trực
 * tiếp (không qua nginx) thì bỏ qua header, dùng địa chỉ socket.
 */
export function resolveClientIp(req: RequestLike): string | null {
  const remote = normalizeIp(req.socket?.remoteAddress ?? req.ip);
  if (remote && !LOOPBACK.includes(remote)) return remote;

  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) {
    const last = forwarded.split(',').pop();
    const ip = normalizeIp(last);
    if (ip) return ip;
  }
  return remote;
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function auditActorFromRequest(req: RequestLike): HrAuditActor {
  const requestId = header(req, 'x-request-id');
  return {
    accountId: req.user?.id ?? null,
    name: req.user?.name ?? null,
    roles: req.user?.roles ?? [],
    ip: resolveClientIp(req),
    userAgent: header(req, 'user-agent')?.slice(0, 512) ?? null,
    requestId:
      requestId && REQUEST_ID.test(requestId) ? requestId : randomUUID(),
  };
}
