import { createHash } from 'crypto';

import { ZaloOaService, type ZaloOaEvent } from './zalo-oa.service';
import { extractVietnamPhone, isUnlinkCommand } from './zalo-phone';

describe('Tách số điện thoại trong tin nhắn OA', () => {
    it.each([
        ['0901234501', '0901234501'],
        ['090 123 4501', '0901234501'],
        ['0901.234.501', '0901234501'],
        ['+84901234501', '0901234501'],
        ['84901234501', '0901234501'],
        ['0084901234501', '0901234501'],
        ['sdt cua toi la 0901234501 nhe', '0901234501'],
        ['SĐT: 0901234501', '0901234501'],
    ])('“%s” -> %s', (input, expected) => {
        expect(extractVietnamPhone(input)).toBe(expected);
    });

    it.each(['', 'chào bạn', 'abc', '123'])('“%s” -> không có số', (input) => {
        expect(extractVietnamPhone(input)).toBeNull();
    });

    it('nhận lệnh huỷ ở nhiều cách viết', () => {
        expect(isUnlinkCommand('HUY')).toBe(true);
        expect(isUnlinkCommand('huỷ')).toBe(true);
        expect(isUnlinkCommand('stop')).toBe(true);
        expect(isUnlinkCommand('huy nhan canh bao')).toBe(true);
    });

    it('không nhầm chữ "huy" giữa câu thành lệnh huỷ', () => {
        expect(isUnlinkCommand('anh Huy gửi số 0901234501')).toBe(false);
    });
});

// ---------------------------------------------------------------------------

const EMPLOYEE = { id: 7, name: 'Ngô Thanh Hà', phone: '0901234508' };

function makeService(found: any = EMPLOYEE) {
    const employeeRepo: any = {
        findOne: jest.fn().mockResolvedValue(found),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const notifyService: any = {
        sendMessage: jest.fn().mockResolvedValue({}),
    };

    return {
        service: new ZaloOaService(employeeRepo, notifyService),
        employeeRepo,
        notifyService,
    };
}

const textEvent = (text: string, senderId = 'zalo-abc'): ZaloOaEvent => ({
    event_name: 'user_send_text',
    sender: { id: senderId },
    message: { text },
});

describe('Webhook Zalo OA — liên kết tài khoản', () => {
    it('nhắn số điện thoại đúng thì lưu zalo_user_id và trả lời xác nhận', async () => {
        const { service, employeeRepo, notifyService } = makeService();

        const result = await service.handleEvent(textEvent('0901234508'));

        expect(result).toEqual({ action: 'linked', employeeId: 7 });
        expect(employeeRepo.findOne).toHaveBeenCalledWith({
            where: { phone: '0901234508', isActive: true },
        });
        // Gỡ liên kết cũ của chính Zalo đó trước, rồi mới gán sang người mới.
        expect(employeeRepo.update).toHaveBeenNthCalledWith(
            1,
            { zaloUserId: 'zalo-abc' },
            { zaloUserId: null },
        );
        expect(employeeRepo.update).toHaveBeenNthCalledWith(2, 7, {
            zaloUserId: 'zalo-abc',
        });
        expect(notifyService.sendMessage.mock.calls[0][1]).toContain('Ngô Thanh Hà');
    });

    it('số không khớp nhân viên nào thì không ghi gì, chỉ báo lại', async () => {
        const { service, employeeRepo, notifyService } = makeService(null);

        const result = await service.handleEvent(textEvent('0999999999'));

        expect(result).toEqual({ action: 'not_found', phone: '0999999999' });
        expect(employeeRepo.update).not.toHaveBeenCalled();
        expect(notifyService.sendMessage.mock.calls[0][1]).toContain(
            'Không tìm thấy nhân viên',
        );
    });

    it('tin không có số thì hướng dẫn chứ không đụng dữ liệu', async () => {
        const { service, employeeRepo, notifyService } = makeService();

        const result = await service.handleEvent(textEvent('chào shop'));

        expect(result).toEqual({ action: 'prompted' });
        expect(employeeRepo.update).not.toHaveBeenCalled();
        expect(notifyService.sendMessage).toHaveBeenCalled();
    });

    it('nhắn HUY thì gỡ liên kết', async () => {
        const { service, employeeRepo } = makeService();

        const result = await service.handleEvent(textEvent('HUY'));

        expect(result).toEqual({ action: 'unlinked', employeeId: 7 });
        expect(employeeRepo.update).toHaveBeenCalledWith(7, { zaloUserId: null });
    });

    it('bỏ quan tâm OA thì gỡ liên kết và không nhắn lại', async () => {
        const { service, employeeRepo, notifyService } = makeService();

        const result = await service.handleEvent({
            event_name: 'unfollow',
            follower: { id: 'zalo-abc' },
        });

        expect(result).toEqual({ action: 'unlinked', employeeId: 7 });
        expect(employeeRepo.update).toHaveBeenCalledWith(7, { zaloUserId: null });
        // Đã bỏ quan tâm thì nhắn cũng không tới, đừng gọi API vô ích.
        expect(notifyService.sendMessage).not.toHaveBeenCalled();
    });

    it('sự kiện lạ thì bỏ qua', async () => {
        const { service, employeeRepo } = makeService();

        const result = await service.handleEvent({ event_name: 'user_send_image' });

        expect(result).toEqual({ action: 'ignored', reason: 'user_send_image' });
        expect(employeeRepo.update).not.toHaveBeenCalled();
    });

    it('trả lời hỏng không làm hỏng việc liên kết', async () => {
        const { service, notifyService } = makeService();
        notifyService.sendMessage.mockRejectedValue(new Error('OA token hết hạn'));

        const result = await service.handleEvent(textEvent('0901234508'));

        expect(result).toEqual({ action: 'linked', employeeId: 7 });
    });
});

describe('Webhook Zalo OA — chữ ký', () => {
    const OLD_ENV = { ...process.env };

    afterEach(() => {
        process.env = { ...OLD_ENV };
    });

    const sign = (rawBody: string, appId: string, timestamp: string, secret: string) =>
        createHash('sha256')
            .update(`${appId}${rawBody}${timestamp}${secret}`)
            .digest('hex');

    it('chữ ký đúng thì cho qua', () => {
        process.env.ZALO_OA_SECRET_KEY = 'secret-key';
        delete process.env.ZALO_OA_WEBHOOK_VERIFY;
        const { service } = makeService();

        const raw = JSON.stringify({ app_id: 'app-1', timestamp: '123' });
        const mac = sign(raw, 'app-1', '123', 'secret-key');

        expect(service.verifySignature(raw, `mac=${mac}`)).toBe(true);
    });

    it('chữ ký sai thì chặn', () => {
        process.env.ZALO_OA_SECRET_KEY = 'secret-key';
        delete process.env.ZALO_OA_WEBHOOK_VERIFY;
        const { service } = makeService();

        const raw = JSON.stringify({ app_id: 'app-1', timestamp: '123' });

        expect(service.verifySignature(raw, 'mac=sai')).toBe(false);
        expect(service.verifySignature(raw, undefined)).toBe(false);
    });

    it('chưa khai secret thì chặn, không mở toang endpoint ghi dữ liệu', () => {
        delete process.env.ZALO_OA_SECRET_KEY;
        delete process.env.ZALO_APP_SECRET;
        delete process.env.ZALO_OA_WEBHOOK_VERIFY;
        const { service } = makeService();

        expect(service.verifySignature('{}', 'mac=bat-ky')).toBe(false);
    });

    it('cờ tắt kiểm tra chỉ dùng khi dò cấu hình', () => {
        process.env.ZALO_OA_WEBHOOK_VERIFY = '0';
        const { service } = makeService();

        expect(service.verifySignature('{}', undefined)).toBe(true);
    });
});
