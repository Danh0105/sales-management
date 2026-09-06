import type { Request } from 'express';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';
import { PolicyStatus } from './policy.enum';

describe('PolicyController approval roles', () => {
    const makeController = () => {
        const service = {
            adminUpdateStatusNote: jest.fn().mockResolvedValue({}),
        };
        const controller = new PolicyController(service as any);
        return { controller, service };
    };

    const requestFor = (roles: string[]) =>
        ({
            user: { id: 16, name: 'Reviewer', roles },
        }) as Request;

    it.each([['saleadmin'], ['salesadmin_la']])(
        'chuẩn hóa DIRECTOR_APPROVED thành SALE_ADMIN_APPROVED cho %s',
        async (role) => {
            const { controller, service } = makeController();
            const dto = {
                status: PolicyStatus.DIRECTOR_APPROVED,
                subjectId: 848,
                userId: 10,
            };

            await controller.adminUpdateStatusNote(1098, dto, requestFor([role]));

            expect(service.adminUpdateStatusNote).toHaveBeenCalledWith(
                1098,
                expect.objectContaining({
                    status: PolicyStatus.SALE_ADMIN_APPROVED,
                }),
                { id: 16, name: 'Reviewer', role: 'salesadmin' },
            );
            expect(dto.status).toBe(PolicyStatus.DIRECTOR_APPROVED);
        },
    );

    it('giữ DIRECTOR_APPROVED khi người duyệt có role director', async () => {
        const { controller, service } = makeController();
        const dto = {
            status: PolicyStatus.DIRECTOR_APPROVED,
            subjectId: 848,
            userId: 10,
        };

        await controller.adminUpdateStatusNote(
            1098,
            dto,
            requestFor(['director']),
        );

        expect(service.adminUpdateStatusNote).toHaveBeenCalledWith(
            1098,
            expect.objectContaining({
                status: PolicyStatus.DIRECTOR_APPROVED,
            }),
            { id: 16, name: 'Reviewer', role: 'director' },
        );
    });
});

describe('PolicyService approval history', () => {
    const makeService = () => {
        const service = Object.create(PolicyService.prototype) as PolicyService;
        const policy = {
            id: 1098,
            subjectId: 848,
            status: PolicyStatus.PENDING,
            note: undefined,
            currentHistoryId: undefined,
        };
        const historyRepo = {
            save: jest.fn().mockResolvedValue({ id: 2000 }),
        };

        (service as any).policyRepo = {
            findOne: jest.fn().mockResolvedValue(policy),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        (service as any).subjectRepo = {
            findOne: jest.fn().mockResolvedValue({
                id: 848,
                name: 'STEM',
                schoolYear: '2026-2027',
                school: { name: 'Trường A', ward: { province: { name: 'TP.HCM' } } },
            }),
        };
        (service as any).historyRepo = historyRepo;
        (service as any).notificationService = {
            markAllAsReadByTypeAndEntity: jest.fn().mockResolvedValue(undefined),
            markAsReadByTypeEntityForReceiver: jest.fn().mockResolvedValue(undefined),
        };

        return { service, historyRepo };
    };

    it.each([
        ['salesadmin', 'SALES_ADMIN_UPDATE'],
        ['director', 'DIRECTOR_UPDATE'],
    ] as const)('lưu action riêng cho %s', async (role, expectedAction) => {
        const { service, historyRepo } = makeService();

        await service.adminUpdateStatusNote(
            1098,
            {
                status: PolicyStatus.REJECTED,
                subjectId: 848,
                userId: 10,
                note: 'Không duyệt',
            },
            { id: 16, name: 'Reviewer', role },
        );

        expect(historyRepo.save).toHaveBeenCalledWith(
            expect.objectContaining({
                action: expectedAction,
                updatedBy: 'Reviewer',
                status: PolicyStatus.REJECTED,
            }),
        );
    });

    it('director duyệt/từ chối: đánh dấu đã đọc cho TẤT CẢ người nhận ban đầu', async () => {
        const { service } = makeService();

        await service.adminUpdateStatusNote(
            1098,
            {
                status: PolicyStatus.REJECTED,
                subjectId: 848,
                userId: 10,
                note: 'Không duyệt',
            },
            { id: 16, name: 'Giám đốc', role: 'director' },
        );

        const notificationService = (service as any).notificationService;
        expect(notificationService.markAllAsReadByTypeAndEntity).toHaveBeenCalledWith(
            'POLICY',
            1098,
        );
        expect(notificationService.markAsReadByTypeEntityForReceiver).not.toHaveBeenCalled();
    });

    it('salesadmin kiểm duyệt: chỉ đánh dấu đã đọc cho đúng người vừa thao tác', async () => {
        const { service } = makeService();

        await service.adminUpdateStatusNote(
            1098,
            {
                status: PolicyStatus.REJECTED,
                subjectId: 848,
                userId: 10,
                note: 'Đã kiểm tra',
            },
            { id: 16, name: 'Sale Admin', role: 'salesadmin' },
        );

        const notificationService = (service as any).notificationService;
        expect(notificationService.markAsReadByTypeEntityForReceiver).toHaveBeenCalledWith(
            'POLICY',
            1098,
            16,
        );
        expect(notificationService.markAllAsReadByTypeAndEntity).not.toHaveBeenCalled();
    });
});
