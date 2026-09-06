import { ForbiddenException } from '@nestjs/common';

import {
    ACADEMIC_ROLE,
    assertCanManageTeaching,
    assertCanSetTeachingRates,
    canSetTeachingRates,
    HR_ROLE,
} from './teaching-roles';

const user = (...roles: string[]) => ({ id: 1, roles }) as any;

const hr = user(HR_ROLE);
const academic = user(ACADEMIC_ROLE);
const both = user(ACADEMIC_ROLE, HR_ROLE);
const director = user('director');

describe('role Giáo vụ', () => {
    it('quản lý được dữ liệu giảng dạy như Nhân sự', () => {
        expect(() => assertCanManageTeaching(academic)).not.toThrow();
        expect(() => assertCanManageTeaching(hr)).not.toThrow();
    });

    it('role chỉ-xem vẫn bị chặn ghi', () => {
        expect(() => assertCanManageTeaching(director)).toThrow(ForbiddenException);
    });

    it('không được khai tiền, Nhân sự thì được', () => {
        expect(canSetTeachingRates(academic)).toBe(false);
        expect(canSetTeachingRates(hr)).toBe(true);
    });

    it('kiêm cả hai role thì giữ quyền của Nhân sự', () => {
        // Cấp thêm role không bao giờ được làm mất quyền đang có.
        expect(canSetTeachingRates(both)).toBe(true);
        expect(() =>
            assertCanSetTeachingRates(both, { ratePerPeriod: 150000 }),
        ).not.toThrow();
    });
});

describe('chặn Giáo vụ khai tiền', () => {
    it('chặn đơn giá mỗi tiết', () => {
        expect(() =>
            assertCanSetTeachingRates(academic, { ratePerPeriod: 150000 }),
        ).toThrow(/đơn giá mỗi tiết/);
    });

    it('chặn các khoản phụ cấp khi chấm công', () => {
        expect(() =>
            assertCanSetTeachingRates(academic, {
                status: 'PRESENT',
                otherCosts: [{ name: 'Xăng xe', amount: 50000 }],
            }),
        ).toThrow(/phụ cấp/);
    });

    it('chặn cả khi đơn giá nằm trong items[] của endpoint hàng loạt', () => {
        // Đây là chỗ dễ thủng nhất: cấp lô không có tiền nhưng từng dòng thì có.
        expect(() =>
            assertCanSetTeachingRates(academic, {
                teacherId: 9,
                items: [
                    { classId: 1 },
                    { classId: 2, ratePerPeriod: 200000 },
                ],
            }),
        ).toThrow(/đơn giá mỗi tiết/);
    });

    it('chặn cả khi gửi null — xoá đơn giá cũng là khai tiền', () => {
        expect(() =>
            assertCanSetTeachingRates(academic, { ratePerPeriod: null }),
        ).toThrow(ForbiddenException);
    });

    it('KHÔNG chặn khi payload không đụng tới tiền', () => {
        // Giáo vụ vẫn sửa được mọi thứ khác trên cùng một form.
        expect(() =>
            assertCanSetTeachingRates(academic, {
                teacherId: 9,
                dayOfWeek: 2,
                startTime: '07:30',
                items: [{ classId: 1 }, { classId: 2 }],
            }),
        ).not.toThrow();
    });

    it('KHÔNG chặn khi field tiền vắng mặt hoàn toàn', () => {
        // `undefined` = client không gửi field, khác hẳn gửi null.
        expect(() =>
            assertCanSetTeachingRates(academic, { ratePerPeriod: undefined }),
        ).not.toThrow();
    });

    it('nêu đủ mọi loại tiền bị đụng trong một thông báo', () => {
        try {
            assertCanSetTeachingRates(academic, {
                ratePerPeriod: 1,
                status: 'PRESENT',
                otherCosts: [{ name: 'Xăng xe', amount: 50000 }],
            });
            throw new Error('đáng lẽ phải ném lỗi');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain('đơn giá mỗi tiết');
            expect(message).toContain('phụ cấp');
        }
    });
});
