import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { BlockList, isIPv4 } from 'net';

/**
 * Mạng Docker của be.kidostudent.kidoedu.vn (compose `school-fee-payment-be`,
 * chỉ gồm api/redis/db của dự án đó). API này gọi sang qua domain nhưng không
 * đi vòng NAT, nên nginx thấy IP của container chứ không phải IP công khai
 * trong DNS. Compose tạo lại mạng ở dải khác thì phải sửa dải này.
 *
 * Khi backend sales chạy ở máy khác be.kidostudent (từ 20/11/2026 chuyển sang
 * 160.250.132.49), request đi ra Internet nên mang IP công khai của máy
 * be.kidostudent: khai thêm bằng `SCHOOL_DIRECTORY_ALLOWED_CIDRS`
 * ("a.b.c.d/nn" hoặc IP lẻ, cách nhau dấu phẩy). Biến này THAY danh sách mặc
 * định, nên phải ghi lại cả dải Docker nếu còn cần.
 */
export const DEFAULT_SCHOOL_DIRECTORY_CIDRS = '172.21.0.0/16';

export function schoolDirectoryAllowList(
    spec: string = process.env.SCHOOL_DIRECTORY_ALLOWED_CIDRS ??
        DEFAULT_SCHOOL_DIRECTORY_CIDRS,
): BlockList {
    const list = new BlockList();
    for (const raw of spec.split(',')) {
        const entry = raw.trim();
        if (!entry) continue;
        const [address, bits] = entry.split('/');
        if (!isIPv4(address)) {
            throw new Error(`SCHOOL_DIRECTORY_ALLOWED_CIDRS: "${entry}" không phải IPv4`);
        }
        const prefix = bits === undefined ? 32 : Number(bits);
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
            throw new Error(`SCHOOL_DIRECTORY_ALLOWED_CIDRS: "${entry}" sai độ dài mạng`);
        }
        list.addSubnet(address, prefix, 'ipv4');
    }
    return list;
}

const withoutIpv4Prefix = (ip: string) => ip.replace(/^::ffff:/i, '');

/**
 * Chỉ tin `X-Real-IP` khi kết nối đến từ nginx trên chính máy này, vì nginx ghi
 * đè header đó bằng `$remote_addr`. Cổng 3010 cũng nghe trên 0.0.0.0: ai nối
 * thẳng vào thì lấy IP của kết nối, header tự khai không có tác dụng.
 * `X-Forwarded-For` không dùng vì nginx chỉ nối thêm vào giá trị client gửi.
 */
export function schoolDirectoryClientIp(
    request: Pick<Request, 'socket' | 'headers'>,
): string {
    const peer = withoutIpv4Prefix(request.socket?.remoteAddress ?? '');
    if (peer !== '127.0.0.1' && peer !== '::1') return peer;

    const realIp = request.headers['x-real-ip'];
    return typeof realIp === 'string' ? withoutIpv4Prefix(realIp.trim()) : peer;
}

@Injectable()
export class SchoolDirectoryGuard implements CanActivate {
    private readonly allowed = schoolDirectoryAllowList();

    canActivate(context: ExecutionContext): boolean {
        const ip = schoolDirectoryClientIp(
            context.switchToHttp().getRequest<Request>(),
        );
        if (isIPv4(ip) && this.allowed.check(ip, 'ipv4')) return true;
        throw new ForbiddenException(
            'Địa chỉ này không được phép lấy danh sách trường',
        );
    }
}
