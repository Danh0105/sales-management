import {
    BadRequestException,
    ForbiddenException,
    UnauthorizedException,
    ValidationPipe,
} from '@nestjs/common';
import { Brackets } from 'typeorm';
import { PolicyService } from './policy.service';
import { PolicyStatus } from './policy.enum';
import { QueryPoliciesDto } from './dto/query-policies.dto';
import { PolicyScope, resolvePolicyScope } from './policy-scope';

// ============================================================
// Helpers
// ============================================================

const CHAINABLE = [
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'orWhere',
    'select',
    'addSelect',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'addOrderBy',
    'limit',
    'offset',
];

function makeQueryBuilder() {
    const qb: any = {};
    for (const method of CHAINABLE) {
        qb[method] = jest.fn().mockReturnValue(qb);
    }
    qb.getCount = jest.fn().mockResolvedValue(0);
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    return qb;
}

function makeService(qb = makeQueryBuilder()) {
    const service = Object.create(PolicyService.prototype) as PolicyService;
    (service as any).policyRepo = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
    };
    return { service, qb };
}

const ALL_SCOPE: PolicyScope = { kind: 'all' };

/** Điều kiện WHERE đã áp dụng, dạng [sql, params]. */
function whereCalls(qb: any): [string, any][] {
    return qb.andWhere.mock.calls
        .filter((call: any[]) => typeof call[0] === 'string')
        .map((call: any[]) => [call[0], call[1]]);
}

function whereSqls(qb: any): string[] {
    return whereCalls(qb).map(([sql]) => sql);
}

/** Chạy whereFactory của Brackets để xem các OR bên trong. */
function bracketsConditions(qb: any): [string, any][] {
    const brackets = qb.andWhere.mock.calls
        .map((call: any[]) => call[0])
        .find((arg: any) => arg instanceof Brackets);

    if (!brackets) return [];

    const inner: any = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
    };
    brackets.whereFactory(inner);

    return [...inner.where.mock.calls, ...inner.orWhere.mock.calls].map(
        (call: any[]) => [call[0], call[1]],
    );
}

const RAW_ROW = {
    policyId: 1054,
    status: PolicyStatus.DIRECTOR_APPROVED,
    createdAt: new Date('2026-08-04T01:43:50.596Z'),
    updatedAt: new Date('2026-08-04T02:00:00.000Z'),
    policyData: { fee: 600000, durationMonths: 9, companyProfit: 5000000 },
    currentHistoryId: 1144,
    employeeId: 28,
    employeeName: 'USER TEST',
    schoolId: 529,
    schoolName: 'Trường TEST',
    subjectId: 795,
    subjectName: 'Kỹ năng sống',
    schoolYear: 'Hè 2026-2027',
    contractNumber: 'T795|2026',
    studentCount: 30,
    totalLessons: 36,
};

// ============================================================
// 1. Validate query parameters (400 cho query không hợp lệ)
// ============================================================

describe('QueryPoliciesDto', () => {
    const pipe = new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
    });
    const metadata = {
        type: 'query' as const,
        metatype: QueryPoliciesDto,
        data: '',
    };

    const transform = (query: Record<string, unknown>) =>
        pipe.transform(query, metadata) as Promise<QueryPoliciesDto>;

    it('áp mặc định page=1, limit=20, sortBy=createdAt, sortOrder=desc', async () => {
        const result = await transform({});

        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
        expect(result.sortBy).toBe('createdAt');
        expect(result.sortOrder).toBe('desc');
    });

    it('ép kiểu số từ query string', async () => {
        const result = await transform({
            schoolId: '45',
            subjectId: '67',
            employeeId: '12',
            page: '3',
            limit: '50',
        });

        expect(result.schoolId).toBe(45);
        expect(result.subjectId).toBe(67);
        expect(result.employeeId).toBe(12);
        expect(result.page).toBe(3);
        expect(result.limit).toBe(50);
    });

    it('chấp nhận năm học thường và năm học Hè', async () => {
        await expect(transform({ schoolYear: '2026-2027' })).resolves.toMatchObject({
            schoolYear: '2026-2027',
        });
        await expect(
            transform({ schoolYear: 'Hè 2026-2027' }),
        ).resolves.toMatchObject({ schoolYear: 'Hè 2026-2027' });
    });

    it('trim search và chấp nhận sortOrder viết hoa', async () => {
        const result = await transform({ search: '  Trường ABC  ', sortOrder: 'ASC' });

        expect(result.search).toBe('Trường ABC');
        expect(result.sortOrder).toBe('asc');
    });

    it.each([
        ['status không thuộc enum', { status: 'APPROVED' }],
        ['ngày sai định dạng', { fromDate: '04-08-2026' }],
        ['ngày không có thật', { toDate: '2026-02-31' }],
        ['tháng không hợp lệ', { fromDate: '2026-13-01' }],
        ['năm học sai định dạng', { schoolYear: '2026' }],
        ['limit vượt 100', { limit: '101' }],
        ['limit nhỏ hơn 1', { limit: '0' }],
        ['page nhỏ hơn 1', { page: '0' }],
        ['schoolId không phải số', { schoolId: 'abc' }],
        ['sortBy ngoài whitelist', { sortBy: 'policyData' }],
        ['sortBy dạng SQL injection', { sortBy: 'p.id; DROP TABLE policy' }],
        ['sortOrder ngoài whitelist', { sortOrder: 'random' }],
        ['tham số lạ', { hackParam: '1' }],
    ])('trả 400 khi %s', async (_label, query) => {
        await expect(transform(query)).rejects.toBeInstanceOf(BadRequestException);
    });
});

// ============================================================
// 2. Phân quyền — phạm vi dữ liệu suy ra từ token
// ============================================================

describe('resolvePolicyScope', () => {
    it.each([['director'], ['saleadmin'], ['troly_gd'], ['ketoan_truong']])(
        'role %s xem toàn bộ chính sách',
        (role) => {
            expect(resolvePolicyScope({ id: 1, roles: [role] })).toEqual({
                kind: 'all',
            });
        },
    );

    it.each([['director_la'], ['salesadmin_la']])(
        'role %s bị giới hạn theo tỉnh 7',
        (role) => {
            expect(resolvePolicyScope({ id: 2, roles: [role] })).toEqual({
                kind: 'province',
                provinceId: 7,
            });
        },
    );

    it('role sales chỉ xem chính sách của trường mình phụ trách', () => {
        expect(resolvePolicyScope({ id: 28, roles: ['sales'] })).toEqual({
            kind: 'own',
            employeeId: 28,
        });
    });

    it('ưu tiên phạm vi rộng nhất khi user có nhiều role', () => {
        expect(
            resolvePolicyScope({ id: 3, roles: ['sales', 'director'] }),
        ).toEqual({ kind: 'all' });
    });

    it.each([[['thuquy']], [['ketoan_congno']], [[]]])(
        'role %s không có quyền xem danh sách',
        (roles) => {
            expect(() => resolvePolicyScope({ id: 4, roles })).toThrow(
                ForbiddenException,
            );
        },
    );

    it('từ chối khi không có user trong token', () => {
        expect(() => resolvePolicyScope(undefined)).toThrow(UnauthorizedException);
    });
});

// ============================================================
// 3. findAllForAdmin — lọc / phân trang / sắp xếp dưới database
// ============================================================

describe('PolicyService.findAllForAdmin', () => {
    it('không truyền filter thì chỉ join, không thêm điều kiện nào', async () => {
        const { service, qb } = makeService();

        await service.findAllForAdmin({}, ALL_SCOPE);

        expect(whereSqls(qb)).toEqual([]);
        expect(qb.innerJoin).toHaveBeenCalledWith('p.subject', 'sub');
        expect(qb.innerJoin).toHaveBeenCalledWith('sub.school', 'sc');
        expect(qb.leftJoin).toHaveBeenCalledWith('sc.employee', 'e');
    });

    it('chỉ chạy 2 query (count + page), không N+1', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(3);
        qb.getRawMany.mockResolvedValue([RAW_ROW, RAW_ROW, RAW_ROW]);

        await service.findAllForAdmin({}, ALL_SCOPE);

        expect(qb.getCount).toHaveBeenCalledTimes(1);
        expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    });

    describe('từng filter riêng lẻ', () => {
        it.each([
            [
                'status',
                { status: PolicyStatus.PENDING },
                'p.status = :status',
                { status: PolicyStatus.PENDING },
            ],
            ['schoolId', { schoolId: 45 }, 'sc.id = :schoolId', { schoolId: 45 }],
            [
                'subjectId',
                { subjectId: 67 },
                'sub.id = :subjectId',
                { subjectId: 67 },
            ],
            [
                'schoolYear',
                { schoolYear: '2026-2027' },
                'sub.schoolYear = :schoolYear',
                { schoolYear: '2026-2027' },
            ],
            [
                'employeeId',
                { employeeId: 12 },
                'sc.employee_id = :employeeId',
                { employeeId: 12 },
            ],
            [
                'fromDate',
                { fromDate: '2026-08-04' },
                'p.createdAt >= :fromDate',
                { fromDate: '2026-08-04 00:00:00.000' },
            ],
            [
                'toDate',
                { toDate: '2026-08-04' },
                'p.createdAt <= :toDate',
                { toDate: '2026-08-04 23:59:59.999' },
            ],
        ])('%s', async (_label, query, sql, params) => {
            const { service, qb } = makeService();

            await service.findAllForAdmin(query as QueryPoliciesDto, ALL_SCOPE);

            expect(whereCalls(qb)).toEqual([[sql, params]]);
        });
    });

    it('search tìm không phân biệt hoa thường trên 4 cột', async () => {
        const { service, qb } = makeService();

        await service.findAllForAdmin({ search: 'Trường ABC' }, ALL_SCOPE);

        expect(bracketsConditions(qb)).toEqual([
            ['LOWER(sc.name) LIKE :searchTerm', { searchTerm: '%trường abc%' }],
            ['LOWER(sub.name) LIKE :searchTerm', { searchTerm: '%trường abc%' }],
            ['LOWER(e.name) LIKE :searchTerm', { searchTerm: '%trường abc%' }],
            [
                'LOWER(sub.contractNumber) LIKE :searchTerm',
                { searchTerm: '%trường abc%' },
            ],
        ]);
    });

    it('escape ký tự đặc biệt của LIKE trong search', async () => {
        const { service, qb } = makeService();

        await service.findAllForAdmin({ search: '100%_a' }, ALL_SCOPE);

        expect(bracketsConditions(qb)[0][1]).toEqual({
            searchTerm: '%100\\%\\_a%',
        });
    });

    it('kết hợp nhiều filter bằng AND', async () => {
        const { service, qb } = makeService();

        await service.findAllForAdmin(
            {
                status: PolicyStatus.PENDING,
                schoolId: 45,
                subjectId: 67,
                schoolYear: '2026-2027',
                employeeId: 12,
                fromDate: '2026-01-01',
                toDate: '2026-12-31',
            },
            ALL_SCOPE,
        );

        expect(whereSqls(qb)).toEqual([
            'p.status = :status',
            'sc.id = :schoolId',
            'sub.id = :subjectId',
            'sub.schoolYear = :schoolYear',
            'sc.employee_id = :employeeId',
            'p.createdAt >= :fromDate',
            'p.createdAt <= :toDate',
        ]);
        // andWhere = AND, không có orWhere ở tầng ngoài
        expect(qb.orWhere).not.toHaveBeenCalled();
    });

    describe('khoảng ngày', () => {
        it('chỉ truyền fromDate vẫn lọc bình thường', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({ fromDate: '2026-08-04' }, ALL_SCOPE);

            expect(whereSqls(qb)).toEqual(['p.createdAt >= :fromDate']);
        });

        it('chỉ truyền toDate vẫn lọc bình thường', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({ toDate: '2026-08-04' }, ALL_SCOPE);

            expect(whereSqls(qb)).toEqual(['p.createdAt <= :toDate']);
        });

        it('fromDate = toDate lấy trọn 1 ngày từ 00:00:00.000 đến 23:59:59.999', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin(
                { fromDate: '2026-08-04', toDate: '2026-08-04' },
                ALL_SCOPE,
            );

            expect(whereCalls(qb)).toEqual([
                ['p.createdAt >= :fromDate', { fromDate: '2026-08-04 00:00:00.000' }],
                ['p.createdAt <= :toDate', { toDate: '2026-08-04 23:59:59.999' }],
            ]);
        });

        it('trả 400 khi fromDate > toDate', async () => {
            const { service } = makeService();

            await expect(
                service.findAllForAdmin(
                    { fromDate: '2026-12-31', toDate: '2026-01-01' },
                    ALL_SCOPE,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('phân trang', () => {
        it('mặc định lấy 20 bản ghi đầu tiên', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, ALL_SCOPE);

            expect(qb.limit).toHaveBeenCalledWith(20);
            expect(qb.offset).toHaveBeenCalledWith(0);
        });

        it('page 3 limit 50 -> offset 100', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({ page: 3, limit: 50 }, ALL_SCOPE);

            expect(qb.limit).toHaveBeenCalledWith(50);
            expect(qb.offset).toHaveBeenCalledWith(100);
        });

        it('chặn limit vượt 100 ngay ở service', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({ limit: 5000 }, ALL_SCOPE);

            expect(qb.limit).toHaveBeenCalledWith(100);
        });

        it('tính meta đúng cho trang giữa', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(135);
            qb.getRawMany.mockResolvedValue([RAW_ROW]);

            const result = await service.findAllForAdmin(
                { page: 2, limit: 20 },
                ALL_SCOPE,
            );

            expect(result.meta).toEqual({
                page: 2,
                limit: 20,
                total: 135,
                totalPages: 7,
                hasNextPage: true,
                hasPreviousPage: true,
            });
        });

        it('trang cuối không còn hasNextPage', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(135);
            qb.getRawMany.mockResolvedValue([RAW_ROW]);

            const result = await service.findAllForAdmin(
                { page: 7, limit: 20 },
                ALL_SCOPE,
            );

            expect(result.meta.hasNextPage).toBe(false);
            expect(result.meta.hasPreviousPage).toBe(true);
        });

        it('đếm total trước khi gắn LIMIT/OFFSET', async () => {
            const { service, qb } = makeService();
            const order: string[] = [];
            qb.getCount.mockImplementation(async () => {
                order.push('count');
                return 0;
            });
            qb.limit.mockImplementation(() => {
                order.push('limit');
                return qb;
            });

            await service.findAllForAdmin({}, ALL_SCOPE);

            expect(order).toEqual(['count', 'limit']);
        });
    });

    describe('sắp xếp', () => {
        it.each([
            ['createdAt', 'p.createdAt'],
            ['updatedAt', 'p.updatedAt'],
            ['schoolName', 'sc.name'],
            ['employeeName', 'e.name'],
        ])('sortBy=%s dùng cột %s', async (sortBy, column) => {
            const { service, qb } = makeService();

            await service.findAllForAdmin(
                { sortBy: sortBy as any, sortOrder: 'asc' },
                ALL_SCOPE,
            );

            expect(qb.orderBy).toHaveBeenCalledWith(column, 'ASC');
        });

        it('mặc định sắp xếp createdAt giảm dần', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, ALL_SCOPE);

            expect(qb.orderBy).toHaveBeenCalledWith('p.createdAt', 'DESC');
        });

        it('luôn thêm tie-breaker p.id để phân trang ổn định', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({ sortBy: 'schoolName' }, ALL_SCOPE);

            expect(qb.addOrderBy).toHaveBeenCalledWith('p.id', 'DESC');
        });
    });

    describe('phạm vi dữ liệu theo token', () => {
        it('scope all không thêm điều kiện phạm vi', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, { kind: 'all' });

            expect(whereSqls(qb)).toEqual([]);
        });

        it('scope province lọc theo tỉnh của token', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, { kind: 'province', provinceId: 7 });

            expect(whereCalls(qb)).toEqual([
                ['pr.id = :scopeProvinceId', { scopeProvinceId: 7 }],
            ]);
        });

        it('scope own lọc theo employee của token', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, { kind: 'own', employeeId: 28 });

            expect(whereCalls(qb)).toEqual([
                ['sc.employee_id = :scopeEmployeeId', { scopeEmployeeId: 28 }],
            ]);
        });

        it('employeeId từ FE không mở rộng được phạm vi của scope own', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin(
                { employeeId: 999 },
                { kind: 'own', employeeId: 28 },
            );

            // Cả hai điều kiện cùng AND -> user 28 không thấy dữ liệu của 999.
            expect(whereCalls(qb)).toEqual([
                ['sc.employee_id = :scopeEmployeeId', { scopeEmployeeId: 28 }],
                ['sc.employee_id = :employeeId', { employeeId: 999 }],
            ]);
        });
    });

    describe('response schema', () => {
        it('map đúng tên trường chuẩn, không đổi tên tuỳ tiện', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(1);
            qb.getRawMany.mockResolvedValue([RAW_ROW]);

            const result = await service.findAllForAdmin({}, ALL_SCOPE);

            expect(result.data[0]).toEqual({
                policyId: 1054,
                status: PolicyStatus.DIRECTOR_APPROVED,
                createdAt: '2026-08-04T01:43:50.596Z',
                updatedAt: '2026-08-04T02:00:00.000Z',
                employeeId: 28,
                employeeName: 'USER TEST',
                schoolId: 529,
                schoolName: 'Trường TEST',
                subjectId: 795,
                subjectName: 'Kỹ năng sống',
                schoolYear: 'Hè 2026-2027',
                contractNumber: 'T795|2026',
                studentCount: 30,
                totalLessons: 36,
                policyData: {
                    fee: 600000,
                    durationMonths: 9,
                    companyProfit: 5000000,
                },
                currentHistoryId: 1144,
            });
        });

        it('không trả cột nhạy cảm của employee', async () => {
            const { service, qb } = makeService();

            await service.findAllForAdmin({}, ALL_SCOPE);

            const selected: string[] = qb.select.mock.calls[0][0];
            expect(selected.join(' ')).not.toMatch(/password|phone|email|fcm/i);
        });

        it('trả null thay vì undefined cho trường thiếu dữ liệu', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(1);
            qb.getRawMany.mockResolvedValue([
                {
                    ...RAW_ROW,
                    employeeId: null,
                    employeeName: null,
                    schoolYear: null,
                    contractNumber: null,
                    currentHistoryId: null,
                },
            ]);

            const result = await service.findAllForAdmin({}, ALL_SCOPE);

            expect(result.data[0]).toMatchObject({
                employeeId: null,
                employeeName: null,
                schoolYear: null,
                contractNumber: null,
                currentHistoryId: null,
            });
        });
    });

    it('không có kết quả trả mảng rỗng và meta hợp lệ', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(0);
        qb.getRawMany.mockResolvedValue([]);

        const result = await service.findAllForAdmin(
            { status: PolicyStatus.REJECTED, schoolId: 999999 },
            ALL_SCOPE,
        );

        expect(result.data).toEqual([]);
        expect(result.meta).toEqual({
            page: 1,
            limit: 20,
            total: 0,
            totalPages: 0,
            hasNextPage: false,
            hasPreviousPage: false,
        });
    });
});

// ============================================================
// 4. getFilterOptions
// ============================================================

describe('PolicyService.getFilterOptions', () => {
    function makeFilterOptionsService() {
        const builders: any[] = [];
        const service = Object.create(PolicyService.prototype) as PolicyService;

        (service as any).policyRepo = {
            createQueryBuilder: jest.fn(() => {
                const qb = makeQueryBuilder();
                builders.push(qb);
                return qb;
            }),
        };

        return { service, builders };
    }

    it('trả đủ 5 nhóm option và sắp xếp năm học mới nhất trước', async () => {
        const { service, builders } = makeFilterOptionsService();

        const responses = [
            [{ id: 45, name: 'Trường ABC' }],
            [{ id: 67, name: 'Kỹ năng sống' }],
            [
                { schoolYear: '2025-2026' },
                { schoolYear: 'Hè 2026-2027' },
                { schoolYear: '2026-2027' },
            ],
            [{ id: 12, name: 'Nguyễn Văn A' }],
        ];

        (service as any).policyRepo.createQueryBuilder = jest.fn(() => {
            const qb = makeQueryBuilder();
            qb.getRawMany = jest
                .fn()
                .mockResolvedValue(responses[builders.length] ?? []);
            builders.push(qb);
            return qb;
        });

        const result = await service.getFilterOptions({ kind: 'all' });

        expect(result.statuses).toEqual([
            { value: PolicyStatus.PENDING, label: 'Chờ duyệt' },
            { value: PolicyStatus.SALE_ADMIN_APPROVED, label: 'Sale admin đã duyệt' },
            { value: PolicyStatus.DIRECTOR_APPROVED, label: 'Giám đốc đã duyệt' },
            { value: PolicyStatus.REJECTED, label: 'Từ chối' },
            { value: PolicyStatus.DRAFT, label: 'Nháp' },
        ]);
        expect(result.schools).toEqual([{ id: 45, name: 'Trường ABC' }]);
        expect(result.subjects).toEqual([{ id: 67, name: 'Kỹ năng sống' }]);
        expect(result.schoolYears).toEqual([
            '2026-2027',
            'Hè 2026-2027',
            '2025-2026',
        ]);
        expect(result.employees).toEqual([{ id: 12, name: 'Nguyễn Văn A' }]);
    });

    it('áp phạm vi tỉnh cho mọi nhóm option', async () => {
        const { service, builders } = makeFilterOptionsService();

        await service.getFilterOptions({ kind: 'province', provinceId: 7 });

        expect(builders).toHaveLength(4);
        for (const qb of builders) {
            expect(qb.andWhere).toHaveBeenCalledWith('pr.id = :scopeProvinceId', {
                scopeProvinceId: 7,
            });
        }
    });

    it('áp phạm vi own cho mọi nhóm option', async () => {
        const { service, builders } = makeFilterOptionsService();

        await service.getFilterOptions({ kind: 'own', employeeId: 28 });

        expect(builders).toHaveLength(4);
        for (const qb of builders) {
            expect(qb.andWhere).toHaveBeenCalledWith(
                'sc.employee_id = :scopeEmployeeId',
                { scopeEmployeeId: 28 },
            );
        }
    });

    it('gom nhóm dưới database thay vì lọc trùng trong code', async () => {
        const { service, builders } = makeFilterOptionsService();

        await service.getFilterOptions({ kind: 'all' });

        for (const qb of builders) {
            expect(qb.groupBy).toHaveBeenCalled();
        }
    });
});
