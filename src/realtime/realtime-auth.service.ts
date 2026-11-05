import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import type { Namespace, Server, Socket } from 'socket.io';
import { Repository } from 'typeorm';
import { Employee } from '../employee/employee.entity';

type SocketUser = {
  id: number;
  name?: string;
  roles: string[];
  exp: number;
};

type SocketState = {
  authUser?: SocketUser;
  authLifecycleBound?: boolean;
};

type ProtectedNamespace = Pick<Server, 'use'> | Pick<Namespace, 'use'>;

const normalizeRoles = (roles: unknown): string[] =>
  Array.isArray(roles)
    ? [
        ...new Set(
          roles.filter((role): role is string => typeof role === 'string'),
        ),
      ].sort()
    : [];

const sameRoles = (left: unknown, right: unknown): boolean =>
  JSON.stringify(normalizeRoles(left)) ===
  JSON.stringify(normalizeRoles(right));

/**
 * Xác thực chung cho mọi namespace Socket.IO.
 *
 * Danh tính chỉ lấy từ JWT đã ký và trạng thái hiện tại trong DB. Các field
 * `employeeId` / `userId` do client tự gửi không còn quyết định room.
 */
@Injectable()
export class RealtimeAuthService {
  private readonly logger = new Logger(RealtimeAuthService.name);
  private readonly protectedNamespaces = new WeakSet<object>();

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,
  ) {}

  protect(namespace: ProtectedNamespace): void {
    const key = namespace as object;
    // Notification/Policy/WeeklyPlan cùng dùng namespace mặc định. Chỉ gắn
    // middleware một lần để không query DB lặp lại ba lần mỗi handshake.
    if (this.protectedNamespaces.has(key)) return;
    this.protectedNamespaces.add(key);

    namespace.use((socket: Socket, next: (err?: Error) => void) => {
      void this.authenticate(socket)
        .then(() => next())
        .catch(() => {
          const error = new Error('UNAUTHORIZED_SOCKET');
          (error as Error & { data?: unknown }).data = {
            code: 'UNAUTHORIZED_SOCKET',
          };
          next(error);
        });
    });
  }

  userOf(socket: Socket): SocketUser | null {
    const user = this.stateOf(socket).authUser;
    return user?.id ? user : null;
  }

  /** Room được tạo hoàn toàn từ id đã xác thực, không nhận tên room từ client. */
  joinOwnRoom(socket: Socket, prefix = 'user_'): number {
    const user = this.userOf(socket);
    if (!user) {
      socket.disconnect(true);
      return 0;
    }
    void socket.join(`${prefix}${user.id}`);
    this.watchLifecycle(socket);
    return user.id;
  }

  private async authenticate(socket: Socket): Promise<void> {
    const token = this.tokenOf(socket);
    const secret = this.config.get<string>('JWT_SECRET');
    if (!token || !secret) throw new Error('missing socket credentials');

    const payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
      secret,
    });
    const id = Number(payload.sub);
    const exp = Number(payload.exp);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(exp)) {
      throw new Error('invalid socket token payload');
    }

    const employee = await this.employeeRepo.findOne({
      where: { id },
      select: ['id', 'name', 'roles', 'isActive'],
    });
    if (!employee || employee.isActive === false) {
      throw new Error('inactive socket account');
    }

    // Role đã đổi sau lúc phát JWT nghĩa là phiên cũ đã bị thu hồi quyền.
    // Buộc đăng nhập lại để cả HTTP và realtime dùng cùng một phiên quyền.
    if (!sameRoles(payload.roles, employee.roles)) {
      throw new Error('socket roles changed');
    }

    this.stateOf(socket).authUser = {
      id: Number(employee.id),
      name: employee.name,
      roles: normalizeRoles(employee.roles),
      exp,
    } satisfies SocketUser;
  }

  private tokenOf(socket: Socket): string {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const authToken = auth?.token;
    if (typeof authToken === 'string' && authToken.trim()) {
      return authToken.trim();
    }

    const header = socket.handshake.headers?.authorization;
    return typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : '';
  }

  private watchLifecycle(socket: Socket): void {
    const state = this.stateOf(socket);
    if (state.authLifecycleBound) return;
    state.authLifecycleBound = true;

    const user = this.userOf(socket);
    if (!user) return socket.disconnect(true) as unknown as void;

    const expiresInMs = user.exp * 1000 - Date.now();
    if (expiresInMs <= 0) return socket.disconnect(true) as unknown as void;

    const expiryTimer = setTimeout(
      () => socket.disconnect(true),
      Math.min(expiresInMs, 2_147_000_000),
    );
    expiryTimer.unref?.();

    // Tài khoản bị khoá hoặc bị đổi role trong lúc đang kết nối phải rời room,
    // không chờ đến lần reconnect / token hết hạn.
    const permissionTimer = setInterval(() => {
      void this.employeeRepo
        .findOne({
          where: { id: user.id },
          select: ['id', 'roles', 'isActive'],
        })
        .then((employee) => {
          if (
            !employee ||
            employee.isActive === false ||
            !sameRoles(user.roles, employee.roles)
          ) {
            socket.disconnect(true);
          }
        })
        .catch((error) => {
          // Lỗi DB thoáng qua không làm gián đoạn toàn bộ realtime. Token vẫn
          // có timer hết hạn; lần kiểm tra kế tiếp sẽ thử lại.
          this.logger.warn(
            `Không kiểm tra được quyền socket ${socket.id}: ${(error as Error).message}`,
          );
        });
    }, 60_000);
    permissionTimer.unref?.();

    socket.once('disconnect', () => {
      clearTimeout(expiryTimer);
      clearInterval(permissionTimer);
    });
  }

  private stateOf(socket: Socket): SocketState {
    return socket.data as SocketState;
  }
}
