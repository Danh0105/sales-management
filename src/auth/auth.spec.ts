import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { AuthService } from './auth.service';
import { TEACHER_STAFF_ROLE } from '../teaching/teaching-roles';

/**
 * Mini App Zalo phải gửi kèm `zaloId` (idByOA) khi giáo viên đăng nhập — đó là
 * đích để gửi cảnh báo. Nhận biết Mini App qua sự có mặt của `uid`.
 */

const PASSWORD = 'matkhau123';
let hash: string;

beforeAll(async () => {
    hash = await bcrypt.hash(PASSWORD, 10);
});

const makeService = (user: any, saved: any[] = []) =>
    new AuthService(
        {
            findByPhone: async () => user,
            saveTeacherZaloIdentifiers: async (id: number, ids: any) => {
                saved.push({ id, ...ids });
            },
        } as any,
        { sign: () => 'token-gia' } as any,
    );

const teacher = (over: any = {}) => ({
    id: 9,
    name: 'Cô Diễm',
    password: hash,
    roles: [TEACHER_STAFF_ROLE],
    ...over,
});

const staff = (over: any = {}) => ({
    id: 140,
    name: 'Nhân sự',
    password: hash,
    roles: ['nhansu'],
    ...over,
});

describe('đăng nhập từ Mini App Zalo', () => {
    it('giáo viên gửi uid mà thiếu zaloId thì bị chặn', async () => {
        const service = makeService(teacher());

        await expect(
            service.login('0900000001', PASSWORD, { uid: 'mini-app-uid' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('lỗi thiếu zaloId có code ổn định để Mini App phân biệt, không phải so message', async () => {
        const service = makeService(teacher());

        await expect(
            service.login('0900000001', PASSWORD, { uid: 'mini-app-uid' }),
        ).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'ZALO_ID_REQUIRED' }),
        });
    });

    it('thông báo nói rõ phải làm gì', async () => {
        const service = makeService(teacher());

        await expect(
            service.login('0900000001', PASSWORD, { uid: 'mini-app-uid' }),
        ).rejects.toThrow(/quan tâm OA/);
    });

    it('gửi đủ uid và zaloId thì vào được và được lưu liên kết', async () => {
        const saved: any[] = [];
        const service = makeService(teacher(), saved);

        const res = await service.login('0900000001', PASSWORD, {
            uid: 'mini-app-uid',
            zaloId: 'idByOA-777',
        });

        expect(res.access_token).toBe('token-gia');
        expect(res.user.zaloId).toBe('idByOA-777');
        expect(saved).toEqual([
            { id: 9, uid: 'mini-app-uid', zaloId: 'idByOA-777' },
        ]);
    });

    it('zaloId chỉ có khoảng trắng cũng coi như thiếu', async () => {
        const service = makeService(teacher());

        await expect(
            service.login('0900000001', PASSWORD, { uid: 'u', zaloId: '   ' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('KHÔNG gửi uid thì vẫn đăng nhập bình thường — web/app cũ không bị ảnh hưởng', async () => {
        const service = makeService(teacher());

        const res = await service.login('0900000001', PASSWORD);
        expect(res.access_token).toBe('token-gia');
    });

    it('role khác giáo viên vào Mini App không bị bắt buộc', async () => {
        // Phạm vi cố ý hẹp: chỉ giáo viên mới nhận cảnh báo qua Zalo.
        const service = makeService(staff());

        const res = await service.login('0900000007', PASSWORD, { uid: 'u' });
        expect(res.access_token).toBe('token-gia');
    });

    it('sai mật khẩu vẫn báo 401, KHÔNG lộ việc thiếu zaloId', async () => {
        // Chốt zaloId phải nằm sau bước so mật khẩu, nếu không người chỉ đoán
        // số điện thoại sẽ biết được số nào là giáo viên.
        const service = makeService(teacher());

        await expect(
            service.login('0900000001', 'sai-mat-khau', { uid: 'u' }),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('số điện thoại không tồn tại vẫn báo 401', async () => {
        const service = makeService(null);

        await expect(
            service.login('0999999999', PASSWORD, { uid: 'u' }),
        ).rejects.toThrow(UnauthorizedException);
    });
});

describe('so khớp zaloId từ lần đăng nhập thứ hai', () => {
    it('lần đầu chưa có zaloId nào ràng buộc thì ghi nhận bình thường (bootstrap)', async () => {
        const saved: any[] = [];
        const service = makeService(teacher({ zaloUserId: null }), saved);

        const res = await service.login('0900000001', PASSWORD, {
            uid: 'u',
            zaloId: 'idByOA-777',
        });

        expect(res.access_token).toBe('token-gia');
        expect(saved).toEqual([{ id: 9, uid: 'u', zaloId: 'idByOA-777' }]);
    });

    it('lần sau gửi đúng zaloId đã ràng buộc thì đăng nhập bình thường', async () => {
        const saved: any[] = [];
        const service = makeService(
            teacher({ zaloUserId: 'idByOA-777' }),
            saved,
        );

        const res = await service.login('0900000001', PASSWORD, {
            uid: 'u',
            zaloId: 'idByOA-777',
        });

        expect(res.access_token).toBe('token-gia');
    });

    it('lần sau gửi zaloId KHÁC với đã ràng buộc thì bị từ chối, không ghi đè', async () => {
        const saved: any[] = [];
        const service = makeService(
            teacher({ zaloUserId: 'idByOA-777' }),
            saved,
        );

        await expect(
            service.login('0900000001', PASSWORD, {
                uid: 'u',
                zaloId: 'idByOA-khac',
            }),
        ).rejects.toThrow(UnauthorizedException);
        expect(saved).toEqual([]);
    });

    it('lỗi lệch zaloId có code ổn định để Mini App phân biệt với sai mật khẩu', async () => {
        const service = makeService(teacher({ zaloUserId: 'idByOA-777' }));

        await expect(
            service.login('0900000001', PASSWORD, {
                uid: 'u',
                zaloId: 'idByOA-khac',
            }),
        ).rejects.toMatchObject({
            response: expect.objectContaining({ code: 'ZALO_ID_MISMATCH' }),
        });
    });

    it('role không phải giáo viên thì không bị so khớp zaloId', async () => {
        const service = makeService(staff({ zaloUserId: 'idByOA-777' }));

        const res = await service.login('0900000007', PASSWORD, {
            uid: 'u',
            zaloId: 'idByOA-khac',
        });
        expect(res.access_token).toBe('token-gia');
    });
});
