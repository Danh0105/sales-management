import { RealtimeAuthService } from './realtime-auth.service';

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(input?: { roles?: string[]; tokenRoles?: string[]; reject?: boolean }) {
  let middleware: any;
  const namespace = {
    use: jest.fn((handler) => {
      middleware = handler;
    }),
  };
  const jwt = {
    verifyAsync: input?.reject
      ? jest.fn().mockRejectedValue(new Error('bad token'))
      : jest.fn().mockResolvedValue({
          sub: 18,
          exp: Math.floor(Date.now() / 1000) + 600,
          roles: input?.tokenRoles ?? input?.roles ?? ['sales'],
        }),
  };
  const employeeRepo = {
    findOne: jest.fn().mockResolvedValue({
      id: 18,
      name: 'Nhân viên kiêm tỉnh',
      roles: input?.roles ?? ['sales'],
      isActive: true,
    }),
  };
  const service = new RealtimeAuthService(
    jwt as any,
    { get: () => 'secret' } as any,
    employeeRepo as any,
  );
  service.protect(namespace as any);
  return { service, namespace, middleware, jwt, employeeRepo };
}

function socket(token?: string) {
  let disconnectListener: (() => void) | undefined;
  return {
    id: 'socket-1',
    data: {},
    handshake: {
      auth: token ? { token } : {},
      query: { employeeId: '999', userId: '999' },
      headers: {},
    },
    join: jest.fn(),
    disconnect: jest.fn(),
    once: jest.fn((event, listener) => {
      if (event === 'disconnect') disconnectListener = listener;
    }),
    cleanup: () => disconnectListener?.(),
  } as any;
}

describe('RealtimeAuthService', () => {
  it('từ chối handshake thiếu token', async () => {
    const { middleware } = setup();
    const next = jest.fn();
    middleware(socket(), next);
    await flush();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UNAUTHORIZED_SOCKET' }),
    );
  });

  it('chỉ join room của danh tính trong JWT/DB, bỏ qua userId client tự chọn', async () => {
    const { service, middleware } = setup();
    const client = socket('valid-token');
    const next = jest.fn();
    middleware(client, next);
    await flush();
    expect(next).toHaveBeenCalledWith();

    expect(service.joinOwnRoom(client)).toBe(18);
    expect(client.join).toHaveBeenCalledWith('user_18');
    expect(client.join).not.toHaveBeenCalledWith('user_999');
    client.cleanup();
  });

  it('token có role cũ bị từ chối sau khi quyền trong DB thay đổi', async () => {
    const { middleware } = setup({ roles: ['sales'], tokenRoles: ['director'] });
    const next = jest.fn();
    middleware(socket('stale-token'), next);
    await flush();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UNAUTHORIZED_SOCKET' }),
    );
  });

  it('token sai hoặc hết hạn bị từ chối ở handshake', async () => {
    const { middleware } = setup({ reject: true });
    const next = jest.fn();
    middleware(socket('expired-token'), next);
    await flush();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'UNAUTHORIZED_SOCKET' }),
    );
  });
});
