import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ActivityLogService } from '../activity-log/activity-log.service';
import {
  LONG_AN_DIRECTOR_RULES,
  LONG_AN_NOTIFICATION_CONTROLLERS,
} from './long-an-director.rules';
import {
  isRestrictedLongAnDirector,
  LongAnScopeService,
} from './long-an-scope.service';

/**
 * Chặn mặc định với Giám đốc Long An, chạy trước mọi guard của route.
 *
 * Không có token hoặc token sai thì bỏ qua để JwtAuthGuard của route trả 401.
 * Vì vậy các API nghiệp vụ phải có JwtAuthGuard: thiếu thì bỏ token là né được.
 */
@Injectable()
export class LongAnDirectorGuard implements CanActivate {
  private readonly logger = new Logger(LongAnDirectorGuard.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly scope: LongAnScopeService,
    private readonly activityLog: ActivityLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context.switchToHttp().getRequest();
    const payload = await this.readToken(req);
    if (!payload || !isRestrictedLongAnDirector(payload.roles)) return true;

    const controller = context.getClass().name;
    const handler = `${controller}.${context.getHandler().name}`;
    const isNotification = LONG_AN_NOTIFICATION_CONTROLLERS.has(controller);
    const allowed = isNotification || (await this.isAllowed(handler, req, payload));

    // Ghi thao tác sửa đã có ActivityLogInterceptor. Ở đây ghi mọi lần đọc và mọi
    // lần bị chặn; riêng thông báo của chính họ bỏ qua vì chuông gọi liên tục.
    if (!allowed || (req.method === 'GET' && !isNotification)) {
      void this.activityLog.record({
        actorId: payload.sub,
        actorName: payload.name,
        actorRoles: payload.roles,
        method: req.method,
        path: req.originalUrl ?? req.url,
        resource: controller,
        statusCode: allowed ? 200 : 403,
        success: allowed,
        context: { action: 'LONG_AN_DIRECTOR_ACCESS', handler, allowed },
      });
    }

    if (!allowed) {
      throw new ForbiddenException(
        'Tài khoản Giám đốc Long An không được truy cập dữ liệu này',
      );
    }
    return true;
  }

  private async readToken(req: any): Promise<any | null> {
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      return await this.jwt.verifyAsync(header.slice(7), {
        secret: this.config.get<string>('JWT_SECRET'),
      });
    } catch {
      return null;
    }
  }

  private async isAllowed(handler: string, req: any, payload: any): Promise<boolean> {
    const rule = LONG_AN_DIRECTOR_RULES[handler];
    if (!rule) return false;
    try {
      return await rule(
        {
          params: req.params ?? {},
          query: req.query ?? {},
          body: req.body ?? {},
          userId: Number(payload.sub),
        },
        this.scope,
      );
    } catch (err: any) {
      // Không kiểm tra được thì chặn, không để lọt dữ liệu vì lỗi truy vấn.
      this.logger.error(`Lỗi kiểm tra phạm vi ${handler}: ${err?.message ?? err}`);
      return false;
    }
  }
}
