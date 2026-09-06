import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class ZaloLocationRateLimitGuard implements CanActivate {
  private readonly requests = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const employeeId = request.user?.id ?? 'anonymous';
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const keys = [`employee:${employeeId}`, `ip:${ip}`];
    for (const key of keys) {
      const recent = (this.requests.get(key) ?? []).filter(
        (time) => time > now - 60_000,
      );
      if (recent.length >= 30) {
        throw new HttpException(
          {
            statusCode: 429,
            code: 'ZALO_LOCATION_RATE_LIMITED',
            message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      recent.push(now);
      this.requests.set(key, recent);
    }
    return true;
  }
}
