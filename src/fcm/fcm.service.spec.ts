import * as admin from 'firebase-admin';
import { FcmService } from './fcm.service';

/**
 * `sendToMultiple`/`sendToDevice` phải fan-out cho MỌI thiết bị (không dừng ở
 * thiết bị đầu tiên lỗi), và dọn token chết qua đúng 1 nguồn duy nhất
 * (`EmployeeFcmTokenService.removeInvalidTokens`) — không tự viết lại logic
 * xoá token trùng lặp trong chính FcmService.
 */
jest.mock('firebase-admin', () => {
  const send = jest.fn();
  return {
    apps: [],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn() },
    messaging: () => ({ send }),
  };
});

function mockSend() {
  return (admin.messaging() as any).send as jest.Mock;
}

function makeService() {
  const employeeFcmTokenService = {
    removeInvalidTokens: jest.fn().mockResolvedValue(undefined),
  };
  const service = new FcmService(employeeFcmTokenService as any);
  return { service, employeeFcmTokenService };
}

describe('FcmService.sendToMultiple', () => {
  beforeEach(() => {
    mockSend().mockReset();
  });

  it('gửi cho mọi token, không dừng khi một thiết bị lỗi (Promise.allSettled)', async () => {
    const { service } = makeService();
    mockSend()
      .mockResolvedValueOnce('ok-1')
      .mockRejectedValueOnce({ code: 'messaging/internal-error' })
      .mockResolvedValueOnce('ok-3');

    const result = await service.sendToMultiple(
      ['t1', 't2', 't3'],
      'Tiêu đề',
      'Nội dung',
    );

    expect(mockSend()).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ total: 3, success: 2, failed: 1 });
  });

  it('gộp token trùng nhau trong cùng 1 lần gửi (không gửi lặp)', async () => {
    const { service } = makeService();
    mockSend().mockResolvedValue('ok');

    await service.sendToMultiple(['dup', 'dup', 'dup'], 'T', 'B');

    expect(mockSend()).toHaveBeenCalledTimes(1);
  });

  it('không gọi FCM khi danh sách token rỗng', async () => {
    const { service } = makeService();
    await service.sendToMultiple([], 'T', 'B');
    expect(mockSend()).not.toHaveBeenCalled();
  });

  it.each([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
    'messaging/invalid-argument',
  ])('token lỗi %s bị dọn qua EmployeeFcmTokenService.removeInvalidTokens', async (code) => {
    const { service, employeeFcmTokenService } = makeService();
    mockSend().mockRejectedValueOnce({ code });

    await service.sendToMultiple(['dead-token'], 'T', 'B');

    expect(employeeFcmTokenService.removeInvalidTokens).toHaveBeenCalledWith(['dead-token']);
  });

  it('lỗi tạm thời (không phải token chết) thì KHÔNG bị xoá', async () => {
    const { service, employeeFcmTokenService } = makeService();
    mockSend().mockRejectedValueOnce({ code: 'messaging/internal-error' });

    await service.sendToMultiple(['flaky-token'], 'T', 'B');

    expect(employeeFcmTokenService.removeInvalidTokens).not.toHaveBeenCalled();
  });

  it('thiết bị A chết không chặn thiết bị B của cùng nhân viên nhận thông báo', async () => {
    const { service, employeeFcmTokenService } = makeService();
    mockSend()
      .mockRejectedValueOnce({ code: 'messaging/registration-token-not-registered' })
      .mockResolvedValueOnce('ok');

    const result = await service.sendToMultiple(
      ['device-a-dead', 'device-b-alive'],
      'T',
      'B',
    );

    expect(result).toMatchObject({ success: 1, failed: 1, deleted: 1 });
    expect(employeeFcmTokenService.removeInvalidTokens).toHaveBeenCalledWith(['device-a-dead']);
  });
});

describe('FcmService.sendToDevice', () => {
  beforeEach(() => {
    mockSend().mockReset();
  });

  it('token chết cũng được dọn qua EmployeeFcmTokenService, không tự xoá bằng repo riêng', async () => {
    const { service, employeeFcmTokenService } = makeService();
    mockSend().mockRejectedValueOnce({ code: 'messaging/invalid-registration-token' });

    await expect(service.sendToDevice('dead-token', 'T', 'B')).rejects.toBeDefined();

    expect(employeeFcmTokenService.removeInvalidTokens).toHaveBeenCalledWith(['dead-token']);
  });
});
