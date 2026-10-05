import { auditActorFromRequest, resolveClientIp } from './hr-audit-actor';

describe('resolveClientIp', () => {
  it('sau nginx: lấy phần tử CUỐI của X-Forwarded-For (do nginx thêm)', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' },
      }),
    ).toBe('203.0.113.9');
  });

  it('client tự gửi X-Forwarded-For giả khi gọi thẳng → bỏ qua header', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '198.51.100.7' },
        headers: { 'x-forwarded-for': '10.0.0.1' },
      }),
    ).toBe('198.51.100.7');
  });

  it('chuẩn hoá IPv4-mapped IPv6', () => {
    expect(
      resolveClientIp({ socket: { remoteAddress: '::ffff:198.51.100.7' } }),
    ).toBe('198.51.100.7');
  });

  it('header rác → rơi về địa chỉ socket', () => {
    expect(
      resolveClientIp({
        socket: { remoteAddress: '::1' },
        headers: { 'x-forwarded-for': 'not-an-ip' },
      }),
    ).toBe('::1');
  });
});

describe('auditActorFromRequest', () => {
  it('chụp người dùng, user-agent, request id hợp lệ', () => {
    expect(
      auditActorFromRequest({
        user: { id: 158, name: 'HR', roles: ['nhansu'] },
        socket: { remoteAddress: '198.51.100.7' },
        headers: { 'user-agent': 'Mozilla/5.0', 'x-request-id': 'req-123' },
      }),
    ).toEqual({
      accountId: 158,
      name: 'HR',
      roles: ['nhansu'],
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0',
      requestId: 'req-123',
    });
  });

  it('request id bất thường → sinh id mới; user-agent bị cắt 512 ký tự', () => {
    const actor = auditActorFromRequest({
      headers: { 'x-request-id': "x'; DROP", 'user-agent': 'a'.repeat(2000) },
    });
    expect(actor.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(actor.userAgent).toHaveLength(512);
    expect(actor.accountId).toBeNull();
  });
});
