import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyStatus } from './policy.enum';
import { QueryPoliciesPageDto } from './dto/query-policies-page.dto';
import { PolicyScope } from './policy-scope';

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

function query(overrides: Partial<QueryPoliciesPageDto> = {}): QueryPoliciesPageDto {
    return { page: 1, limit: 12, ...overrides } as QueryPoliciesPageDto;
}

function whereCalls(qb: any): [string, any][] {
    return qb.andWhere.mock.calls
        .filter((call: any[]) => typeof call[0] === 'string')
        .map((call: any[]) => [call[0], call[1]]);
}

/** Dòng raw như Postgres trả về (Date object cho timestamp). */
function rawRow(id: number, overrides: Record<string, any> = {}) {
    return {
        policyId: id,
        policyStatus: PolicyStatus.DIRECTOR_APPROVED,
        policyCreatedAt: new Date('2026-08-04T08:30:00.000Z'),
        schoolId: 10,
        schoolName: 'Trường ABC',
        subjectId: 25,
        subjectName: 'STEM',
        schoolYear: '2025-2026',
        employeeId: 7,
        employeeName: 'Nguyễn Văn A',
        ...overrides,
    };
}

// ============================================================
// 1. Clamp page/limit theo đúng công thức FE chốt
// ============================================================

describe('QueryPoliciesPageDto', () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const metadata = {
        type: 'query' as const,
        metatype: QueryPoliciesPageDto,
        data: '',
    };

    const transform = (q: Record<string, unknown>) =>
        pipe.transform(q, metadata) as Promise<QueryPoliciesPageDto>;

    it('mặc định page=1, limit=12', async () => {
        const result = await transform({});

        expect(result.page).toBe(1);
        expect(result.limit).toBe(12);
    });

    it.each([
        ['page=0 -> 1', { page: '0' }, 'page', 1],
        ['page âm -> 1', { page: '-5' }, 'page', 1],
        ['page không phải số -> 1', { page: 'abc' }, 'page', 1],
        ['page thập phân -> phần nguyên', { page: '2.7' }, 'page', 2],
        ['page hợp lệ giữ nguyên', { page: '3' }, 'page', 3],
        ['limit=0 -> 12', { limit: '0' }, 'limit', 12],
        // Theo đúng công thức FE chốt: -1 là truthy nên không rơi vào `|| 12`,
        // Math.max(-1, 1) = 1.
        ['limit âm -> 1', { limit: '-1' }, 'limit', 1],
        ['limit không phải số -> 12', { limit: 'abc' }, 'limit', 12],
        ['limit vượt 100 -> 100', { limit: '5000' }, 'limit', 100],
        ['limit=100 giữ nguyên', { limit: '100' }, 'limit', 100],
        ['limit hợp lệ giữ nguyên', { limit: '24' }, 'limit', 24],
    ])('clamp %s', async (_label, input, field, expected) => {
        const result = await transform(input);

        expect(result[field as 'page' | 'limit']).toBe(expected);
    });

    it('bỏ qua tham số lạ thay vì báo lỗi', async () => {
        const result = await transform({ sortBy: 'createdAt', sortOrder: 'desc' });

        expect(result).not.toHaveProperty('sortBy');
        expect(result).not.toHaveProperty('sortOrder');
        expect(result.page).toBe(1);
    });

    it('vẫn ép kiểu và validate các ID', async () => {
        const result = await transform({
            schoolId: '10',
            subjectId: '25',
            employeeId: '7',
        });

        expect(result.schoolId).toBe(10);
        expect(result.subjectId).toBe(25);
        expect(result.employeeId).toBe(7);
    });

    it.each([
        ['schoolId không phải số', { schoolId: 'abc' }],
        ['schoolId = 0', { schoolId: '0' }],
        ['subjectId âm', { subjectId: '-3' }],
        ['employeeId thập phân', { employeeId: '1.5' }],
        ['status ngoài enum', { status: 'APPROVED' }],
        ['fromDate sai định dạng', { fromDate: '04-08-2026' }],
        ['toDate không có thật', { toDate: '2026-02-31' }],
        ['schoolYear sai định dạng', { schoolYear: '2026' }],
    ])('trả 400 khi %s', async (_label, input) => {
        await expect(transform(input)).rejects.toBeInstanceOf(BadRequestException);
    });
});

// ============================================================
// 2. findAllPaginated
// ============================================================

describe('PolicyService.findAllPaginated', () => {
    it('lọc dưới database trước khi phân trang', async () => {
        const { service, qb } = makeService();
        const order: string[] = [];
        qb.andWhere.mockImplementation(() => {
            order.push('where');
            return qb;
        });
        qb.offset.mockImplementation(() => {
            order.push('offset');
            return qb;
        });

        await service.findAllPaginated(
            query({ status: PolicyStatus.PENDING, schoolId: 10 }),
            ALL_SCOPE,
        );

        expect(order).toEqual(['where', 'where', 'offset']);
    });

    it('phân trang bằng LIMIT/OFFSET ở database', async () => {
        const { service, qb } = makeService();

        await service.findAllPaginated(query({ page: 4, limit: 12 }), ALL_SCOPE);

        expect(qb.limit).toHaveBeenCalledWith(12);
        expect(qb.offset).toHaveBeenCalledWith(36);
    });

    it('page=1&limit=12 lấy tối đa 12 bản ghi', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(100);
        qb.getRawMany.mockResolvedValue(
            Array.from({ length: 12 }, (_, i) => rawRow(1000 - i)),
        );

        const result = await service.findAllPaginated(query(), ALL_SCOPE);

        expect(result.data).toHaveLength(12);
        expect(result.pagination).toEqual({
            page: 1,
            limit: 12,
            total: 100,
            totalPages: 9,
        });
    });

    it('trang cuối trả đúng số bản ghi còn lại', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(100);
        qb.getRawMany.mockResolvedValue(
            Array.from({ length: 4 }, (_, i) => rawRow(100 - i)),
        );

        const result = await service.findAllPaginated(
            query({ page: 9, limit: 12 }),
            ALL_SCOPE,
        );

        expect(qb.offset).toHaveBeenCalledWith(96);
        expect(result.data).toHaveLength(4);
        expect(result.pagination.totalPages).toBe(9);
    });

    it('sắp xếp cố định createdAt DESC rồi id DESC', async () => {
        const { service, qb } = makeService();

        await service.findAllPaginated(query(), ALL_SCOPE);

        expect(qb.orderBy).toHaveBeenCalledWith('p.createdAt', 'DESC');
        expect(qb.addOrderBy).toHaveBeenCalledWith('p.id', 'DESC');
    });

    it('không truy vấn riêng từng nhân viên — đúng 2 query mỗi request', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(50);
        qb.getRawMany.mockResolvedValue([rawRow(1), rawRow(2), rawRow(3)]);

        await service.findAllPaginated(query(), ALL_SCOPE);

        expect((service as any).policyRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
        expect(qb.getCount).toHaveBeenCalledTimes(1);
        expect(qb.getRawMany).toHaveBeenCalledTimes(1);
    });

    it('join many-to-one nên mỗi chính sách chỉ xuất hiện một lần', async () => {
        const { service, qb } = makeService();
        qb.getCount.mockResolvedValue(3);
        qb.getRawMany.mockResolvedValue([rawRow(1), rawRow(2), rawRow(3)]);

        const result = await service.findAllPaginated(query(), ALL_SCOPE);

        const ids = result.data.map((item) => item.policyId);
        expect(new Set(ids).size).toBe(ids.length);
        // Không cần DISTINCT vì subject/school/employee đều là quan hệ many-to-one.
        expect(qb.select.mock.calls[0][0]).not.toContain('DISTINCT');
    });

    describe('bộ lọc', () => {
        it.each([
            [
                'status',
                { status: PolicyStatus.DIRECTOR_APPROVED },
                'p.status = :status',
                { status: PolicyStatus.DIRECTOR_APPROVED },
            ],
            ['schoolId', { schoolId: 10 }, 'sc.id = :schoolId', { schoolId: 10 }],
            ['subjectId', { subjectId: 25 }, 'sub.id = :subjectId', { subjectId: 25 }],
            [
                'schoolYear',
                { schoolYear: '2025-2026' },
                'sub.schoolYear = :schoolYear',
                { schoolYear: '2025-2026' },
            ],
            [
                'employeeId',
                { employeeId: 7 },
                'sc.employee_id = :employeeId',
                { employeeId: 7 },
            ],
        ])('%s', async (_label, filter, sql, params) => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query(filter as any), ALL_SCOPE);

            expect(whereCalls(qb)).toEqual([[sql, params]]);
        });

        it('kết hợp nhiều filter bằng AND và vẫn đếm total đúng', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(37);
            qb.getRawMany.mockResolvedValue([rawRow(1)]);

            const result = await service.findAllPaginated(
                query({
                    status: PolicyStatus.DIRECTOR_APPROVED,
                    schoolId: 10,
                    subjectId: 25,
                    schoolYear: '2025-2026',
                    employeeId: 7,
                    fromDate: '2026-01-01',
                    toDate: '2026-12-31',
                }),
                ALL_SCOPE,
            );

            expect(whereCalls(qb).map(([sql]) => sql)).toEqual([
                'p.status = :status',
                'sc.id = :schoolId',
                'sub.id = :subjectId',
                'sub.schoolYear = :schoolYear',
                'sc.employee_id = :employeeId',
                'p.createdAt >= :fromDate',
                'p.createdAt <= :toDate',
            ]);
            expect(qb.orWhere).not.toHaveBeenCalled();
            expect(result.pagination).toEqual({
                page: 1,
                limit: 12,
                total: 37,
                totalPages: 4,
            });
        });
    });

    describe('khoảng ngày theo ngày tạo chính sách', () => {
        it('fromDate tính từ 00:00:00, toDate đến hết 23:59:59.999', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(
                query({ fromDate: '2026-08-04', toDate: '2026-08-04' }),
                ALL_SCOPE,
            );

            expect(whereCalls(qb)).toEqual([
                ['p.createdAt >= :fromDate', { fromDate: '2026-08-04 00:00:00.000' }],
                ['p.createdAt <= :toDate', { toDate: '2026-08-04 23:59:59.999' }],
            ]);
        });

        it('chỉ truyền một đầu khoảng ngày vẫn lọc', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(
                query({ fromDate: '2026-08-04' }),
                ALL_SCOPE,
            );

            expect(whereCalls(qb).map(([sql]) => sql)).toEqual([
                'p.createdAt >= :fromDate',
            ]);
        });

        it('trả 400 khi fromDate > toDate', async () => {
            const { service } = makeService();

            await expect(
                service.findAllPaginated(
                    query({ fromDate: '2026-12-31', toDate: '2026-01-01' }),
                    ALL_SCOPE,
                ),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('phân quyền', () => {
        it('scope all không thêm điều kiện phạm vi', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query(), { kind: 'all' });

            expect(whereCalls(qb)).toEqual([]);
        });

        it('scope province lọc theo tỉnh trong token', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query(), {
                kind: 'province',
                provinceId: 7,
            });

            expect(whereCalls(qb)).toEqual([
                ['pr.id = :scopeProvinceId', { scopeProvinceId: 7 }],
            ]);
        });

        it('scope own lọc theo employee trong token', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query(), { kind: 'own', employeeId: 17 });

            expect(whereCalls(qb)).toEqual([
                ['sc.employee_id = :scopeEmployeeId', { scopeEmployeeId: 17 }],
            ]);
        });

        it('employeeId từ FE không mở rộng được phạm vi', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query({ employeeId: 999 }), {
                kind: 'own',
                employeeId: 17,
            });

            expect(whereCalls(qb)).toEqual([
                ['sc.employee_id = :scopeEmployeeId', { scopeEmployeeId: 17 }],
                ['sc.employee_id = :employeeId', { employeeId: 999 }],
            ]);
        });
    });

    describe('response', () => {
        it('map đúng contract policyId / policyStatus / policyCreatedAt', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(1);
            qb.getRawMany.mockResolvedValue([rawRow(123)]);

            const result = await service.findAllPaginated(query(), ALL_SCOPE);

            expect(result.data[0]).toEqual({
                policyId: 123,
                policyStatus: 'DIRECTOR_APPROVED',
                policyCreatedAt: '2026-08-04T08:30:00.000Z',
                schoolId: 10,
                schoolName: 'Trường ABC',
                subjectId: 25,
                subjectName: 'STEM',
                schoolYear: '2025-2026',
                employeeId: 7,
                employeeName: 'Nguyễn Văn A',
            });
        });

        it('không trả cột nhạy cảm của employee', async () => {
            const { service, qb } = makeService();

            await service.findAllPaginated(query(), ALL_SCOPE);

            expect(qb.select.mock.calls[0][0].join(' ')).not.toMatch(
                /password|phone|email|fcm/i,
            );
        });

        it('trường thiếu dữ liệu trả null', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(1);
            qb.getRawMany.mockResolvedValue([
                rawRow(1, { employeeId: null, employeeName: null, schoolYear: null }),
            ]);

            const result = await service.findAllPaginated(query(), ALL_SCOPE);

            expect(result.data[0]).toMatchObject({
                employeeId: null,
                employeeName: null,
                schoolYear: null,
            });
        });

        it('không có dữ liệu vẫn trả pagination hợp lệ', async () => {
            const { service, qb } = makeService();
            qb.getCount.mockResolvedValue(0);
            qb.getRawMany.mockResolvedValue([]);

            const result = await service.findAllPaginated(
                query({ schoolId: 999999 }),
                ALL_SCOPE,
            );

            expect(result).toEqual({
                data: [],
                pagination: { page: 1, limit: 12, total: 0, totalPages: 0 },
            });
        });
    });

    it('clamp lại page/limit khi service được gọi trực tiếp', async () => {
        const { service, qb } = makeService();

        await service.findAllPaginated(
            { page: 0, limit: 5000 } as QueryPoliciesPageDto,
            ALL_SCOPE,
        );

        expect(qb.limit).toHaveBeenCalledWith(100);
        expect(qb.offset).toHaveBeenCalledWith(0);
    });
});
