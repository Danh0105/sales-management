import { ConflictException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyStatus } from './policy.enum';

/**
 * Mỗi môn chỉ có 1 chính sách. Sửa / gửi duyệt lại diễn ra trên chính bản đó —
 * không sinh thêm bản mới (dữ liệu cũ tích gần 100 bản thừa trước 03/11/2026).
 */
describe('PolicyService — mỗi môn 1 chính sách', () => {
    const subject = (schoolYear: string) => ({
        id: 848,
        name: 'Kỹ năng sống',
        schoolYear,
        school: { name: 'TH A', ward: { province: { name: 'HCM' } } },
    });

    function makeService(options: { existing?: any; schoolYear?: string } = {}) {
        const service = Object.create(PolicyService.prototype) as PolicyService;
        const sql: string[] = [];
        const manager = {
            query: jest.fn(async (text: string) => (sql.push(text), [])),
            findOne: jest.fn().mockResolvedValue(options.existing ?? null),
            create: jest.fn((_entity: any, data: any) => data),
            save: jest.fn(async (data: any) => ({ id: 2000, ...data })),
        };
        Object.assign(service as any, {
            subjectRepo: {
                findOne: jest
                    .fn()
                    .mockResolvedValue(subject(options.schoolYear ?? '2026-2027')),
            },
            policyRepo: {
                findOne: jest.fn().mockResolvedValue(null),
                update: jest.fn(),
            },
            historyRepo: { save: jest.fn().mockResolvedValue({ id: 3000 }) },
            dataSource: { transaction: async (fn: any) => fn(manager) },
        });
        return { service, manager, sql };
    }

    it('từ chối tạo thêm khi môn đã có chính sách', async () => {
        const { service, manager } = makeService({
            existing: { id: 1190, subjectId: 848, status: PolicyStatus.REJECTED },
        });

        await expect(
            service.create({
                subjectId: 848,
                data: { fee: 1 },
                status: PolicyStatus.DRAFT,
            } as any),
        ).rejects.toThrow(ConflictException);

        expect(manager.save).not.toHaveBeenCalled();
    });

    it('khoá dòng môn học trước khi kiểm tra để bấm đúp không lọt 2 bản', async () => {
        const { service, manager, sql } = makeService();

        await service.create({
            subjectId: 848,
            data: { fee: 1 },
            status: PolicyStatus.DRAFT,
        } as any);

        expect(sql[0]).toContain('FOR UPDATE');
        expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
            manager.findOne.mock.invocationCallOrder[0],
        );
        expect(manager.save).toHaveBeenCalledTimes(1);
    });

    it('sửa chính sách năm cũ (tự duyệt) cập nhật tại chỗ, không sinh bản mới', async () => {
        const service = Object.create(PolicyService.prototype) as PolicyService;
        const policy = {
            id: 761,
            subjectId: 610,
            data: { fee: 1 },
            status: PolicyStatus.DIRECTOR_APPROVED,
            durationMonths: 9,
        };
        const execute = jest.fn();
        const qb: any = {
            update: () => qb,
            set: () => qb,
            where: () => qb,
            andWhere: () => qb,
            execute,
        };
        const policyRepo = {
            findOne: jest.fn().mockResolvedValue(policy),
            save: jest.fn(async (p: any) => p),
            createQueryBuilder: () => qb,
        };
        const manager = {
            getRepository: (entity: any) =>
                entity.name === 'Policy' ? policyRepo : { save: jest.fn() },
        };
        Object.assign(service as any, {
            subjectRepo: {
                findOne: jest.fn().mockResolvedValue({ ...subject('2025-2026'), id: 610 }),
            },
            dataSource: { transaction: async (fn: any) => fn(manager) },
        });

        const saved = await service.update(761, {
            subjectId: 610,
            data: { fee: 2 },
        } as any);

        expect(policyRepo.save).toHaveBeenCalledTimes(1);
        const [row] = policyRepo.save.mock.calls[0];
        expect(row.id).toBe(761);
        expect(row.data).toEqual({ fee: 2 });
        expect(row.status).toBe(PolicyStatus.DIRECTOR_APPROVED);
        // Không gửi durationMonths thì giữ nguyên.
        expect(row.durationMonths).toBe(9);
        expect(saved.id).toBe(761);
    });
});
