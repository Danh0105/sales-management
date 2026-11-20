import { ExecutionContext, ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';

import { SchoolDirectoryController } from './school-directory.controller';
import {
    SchoolDirectoryGuard,
    schoolDirectoryAllowList,
    schoolDirectoryClientIp,
} from './school-directory.guard';
import { SchoolDirectoryService } from './school-directory.service';
import { School } from './schools.entity';

const ALLOWED_IP = '172.21.0.2';

/** Giả lập cả phần query nạp thừa: dữ liệu nhạy cảm vẫn không được lọt ra. */
const row = {
    id: 7,
    name: 'THCS A',
    address: 'Số 1',
    phone: '028',
    taxCode: '0301',
    budgetCode: null,
    representative: 'Hiệu trưởng',
    scale: 500,
    classCount: 12,
    status: 1,
    latitude: 10.1,
    longitude: 106.1,
    employee: { id: 1, name: 'NV', password: 'hash', bankAccountNumber: '123' },
    schoolExpenses: [{ id: 9, totalOutside: 1000 }],
    subjects: [{ id: 3 }],
    ward: { id: 5, name: 'Phường 1', province: { id: 6, name: 'TP.HCM' } },
};

const contextOf = (peer: string, headers: Record<string, string> = {}) =>
    ({
        switchToHttp: () => ({
            getRequest: () => ({ socket: { remoteAddress: peer }, headers }),
        }),
    }) as unknown as ExecutionContext;

describe('SchoolDirectoryGuard', () => {
    const guard = new SchoolDirectoryGuard();

    it('nhận container be.kidostudent đi qua nginx', () => {
        expect(
            guard.canActivate(
                contextOf('127.0.0.1', { 'x-real-ip': ALLOWED_IP }),
            ),
        ).toBe(true);
        expect(
            guard.canActivate(
                contextOf('::ffff:127.0.0.1', { 'x-real-ip': '172.21.200.9' }),
            ),
        ).toBe(true);
    });

    it('nối thẳng cổng 3010 thì bỏ qua X-Real-IP tự khai', () => {
        const forged = contextOf('203.0.113.9', { 'x-real-ip': ALLOWED_IP });
        expect(() => guard.canActivate(forged)).toThrow(ForbiddenException);
        expect(
            guard.canActivate(contextOf(`::ffff:${ALLOWED_IP}`)),
        ).toBe(true);
    });

    it.each([
        ['IP Internet', '203.0.113.9'],
        ['IP công khai của VPS', '160.250.132.143'],
        ['mạng Docker dự án khác', '172.22.0.2'],
        ['gateway tuyển dụng', '172.31.250.1'],
        ['giá trị rác', 'not-an-ip'],
        ['nhiều IP', `${ALLOWED_IP}, 203.0.113.9`],
    ])('từ chối %s', (_label, ip) => {
        expect(() =>
            guard.canActivate(contextOf('127.0.0.1', { 'x-real-ip': ip })),
        ).toThrow(ForbiddenException);
    });

    it('từ nginx mà thiếu X-Real-IP thì coi là loopback và từ chối', () => {
        expect(() => guard.canActivate(contextOf('127.0.0.1'))).toThrow(
            ForbiddenException,
        );
    });

    it('không đọc X-Forwarded-For', () => {
        const req = {
            socket: { remoteAddress: '127.0.0.1' },
            headers: {
                'x-forwarded-for': ALLOWED_IP,
                'x-real-ip': '203.0.113.9',
            },
        };
        expect(schoolDirectoryClientIp(req as never)).toBe('203.0.113.9');
    });
});

describe('SCHOOL_DIRECTORY_ALLOWED_CIDRS', () => {
    it('mặc định chỉ dải Docker của be.kidostudent', () => {
        const list = schoolDirectoryAllowList(undefined);
        expect(list.check('172.21.3.4', 'ipv4')).toBe(true);
        expect(list.check('160.250.132.143', 'ipv4')).toBe(false);
    });

    it('khai thêm IP công khai của máy be.kidostudent (IP lẻ = /32)', () => {
        const list = schoolDirectoryAllowList('172.21.0.0/16, 160.250.132.143');
        expect(list.check('160.250.132.143', 'ipv4')).toBe(true);
        expect(list.check('160.250.132.144', 'ipv4')).toBe(false);
        expect(list.check('172.21.200.9', 'ipv4')).toBe(true);
    });

    it('giá trị sai thì báo lỗi ngay lúc khởi động', () => {
        expect(() => schoolDirectoryAllowList('abc')).toThrow('không phải IPv4');
        expect(() => schoolDirectoryAllowList('10.0.0.0/40')).toThrow('sai độ dài mạng');
    });
});

describe('GET /school-directory', () => {
    let app: INestApplication;
    const qb = {
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn(),
        getOne: jest.fn(),
    };
    const repo = { createQueryBuilder: () => qb };
    const allowed = (path: string) =>
        request(app.getHttpServer()).get(path).set('X-Real-IP', ALLOWED_IP);

    beforeAll(async () => {
        const module = await Test.createTestingModule({
            controllers: [SchoolDirectoryController],
            providers: [
                SchoolDirectoryService,
                { provide: getRepositoryToken(School), useValue: repo },
            ],
        }).compile();
        app = module.createNestApplication();
        await app.init();
    });

    afterAll(() => app.close());

    beforeEach(() => {
        jest.clearAllMocks();
        qb.getManyAndCount.mockResolvedValue([[row], 1]);
        qb.getOne.mockResolvedValue(row);
    });

    it('chỉ trả các cột danh mục, không kèm nhân viên hay chi phí', async () => {
        const res = await allowed('/school-directory').expect(200);
        expect(res.body.data).toEqual([
            {
                id: 7,
                name: 'THCS A',
                address: 'Số 1',
                phone: '028',
                taxCode: '0301',
                budgetCode: null,
                representative: 'Hiệu trưởng',
                scale: 500,
                classCount: 12,
                status: 1,
                ward: { id: 5, name: 'Phường 1' },
                province: { id: 6, name: 'TP.HCM' },
            },
        ]);
        expect(res.body.pagination).toEqual({
            total: 1,
            page: 1,
            limit: 50,
            totalPages: 1,
            hasNextPage: false,
        });
    });

    it('query không nạp cột hay quan hệ ngoài danh mục', async () => {
        await allowed('/school-directory').expect(200);
        const selected: string[] = qb.select.mock.calls[0][0];
        expect(selected.some((c) => /employee|expense|password/i.test(c))).toBe(
            false,
        );
        expect(qb.leftJoin.mock.calls.map(([path]) => path)).toEqual([
            'school.ward',
            'ward.province',
        ]);
    });

    it('chi tiết một trường cùng bộ cột, không có thì 404', async () => {
        const res = await allowed('/school-directory/7').expect(200);
        expect(Object.keys(res.body)).not.toContain('employee');
        expect(res.body.id).toBe(7);
        qb.getOne.mockResolvedValue(null);
        await allowed('/school-directory/8').expect(404);
    });

    it('địa chỉ khác bị 403 ở cả danh sách và chi tiết, không chạm DB', async () => {
        const server = request(app.getHttpServer());
        await server
            .get('/school-directory')
            .set('X-Real-IP', '203.0.113.9')
            .set('X-Forwarded-For', ALLOWED_IP)
            .expect(403);
        await server.get('/school-directory').expect(403);
        await server
            .get('/school-directory/7')
            .set('X-Real-IP', '203.0.113.9')
            .expect(403);
        expect(qb.getManyAndCount).not.toHaveBeenCalled();
        expect(qb.getOne).not.toHaveBeenCalled();
    });

    it.each(['limit=201', 'limit=0', 'page=0', 'page=abc', 'provinceId=x'])(
        'tham số sai %s → 400',
        async (qs) => {
            await allowed(`/school-directory?${qs}`).expect(400);
        },
    );

    it('lọc và tìm kiếm, ký tự đại diện trong từ khoá được thoát', async () => {
        await allowed(
            '/school-directory?keyword=50%25_a&provinceId=6&wardId=5&page=2&limit=20',
        ).expect(200);
        expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
            keyword: '%50\\%\\_a%',
        });
        expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
            provinceId: 6,
        });
        expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
            wardId: 5,
        });
        expect(qb.skip).toHaveBeenCalledWith(20);
        expect(qb.take).toHaveBeenCalledWith(20);
    });
});
