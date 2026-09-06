import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';

import { Policy } from './entities/policy.entity';
import { Subject } from '../subject/subject.entity';
import { CreatePolicyDto } from './dto/create-policy.dto';
import { UpdatePolicyDto } from './dto/update-policy.dto';
import { AdminUpdatePolicyDto } from './dto/admin-update.dto';
import { DirectorUpdatePolicyDto } from './dto/director-update-policy.dto';
import { getDiff } from './getDiff';
import { PolicyHistory } from './entities/policy-history.entity';
import { PolicyStatus } from './policy.enum';

import { PolicyGateway } from './policy.gateway';
import { Employee } from '../employee/employee.entity';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import { NotificationService } from '../notifications/services/notification.service';
import fixVietnamese from '../utils/fixVietnamese';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import {
    POLICY_LIST_MAX_LIMIT,
    PolicySortField,
    QueryPoliciesDto,
} from './dto/query-policies.dto';
import {
    clampLimit,
    clampPage,
    QueryPoliciesPageDto,
} from './dto/query-policies-page.dto';
import {
    POLICY_STATUS_LABELS,
    PolicyFilterOptions,
    PolicyListItem,
    PolicyListResponse,
    PolicyPageItem,
    PolicyPageResponse,
} from './dto/policy-list-item.dto';
import { PolicyScope } from './policy-scope';

/** Bộ filter dùng chung cho GET /policies/all và GET /policies/admin/all. */
type PolicyFilters = Pick<
    QueryPoliciesDto,
    | 'status'
    | 'schoolId'
    | 'subjectId'
    | 'schoolYear'
    | 'employeeId'
    | 'fromDate'
    | 'toDate'
    | 'search'
>;

/** Whitelist sortBy -> cột thật, chặn SQL injection qua query param. */
const POLICY_SORT_COLUMNS: Record<PolicySortField, string> = {
    createdAt: 'p.createdAt',
    updatedAt: 'p.updatedAt',
    schoolName: 'sc.name',
    employeeName: 'e.name',
};

/** Escape ký tự đặc biệt của LIKE để người dùng gõ "%" không quét toàn bảng. */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toIsoString(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumberOrNull(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
}

function normalizeYear(input: string): number {
    const clean = input.replace('Hè ', '');
    return Number(clean.split('-')[0]);
}
@Injectable()
export class PolicyService {
    constructor(
        @InjectRepository(Policy)
        private readonly policyRepo: Repository<Policy>,

        @InjectRepository(Subject)
        private readonly subjectRepo: Repository<Subject>,

        @InjectRepository(PolicyHistory)
        private readonly historyRepo: Repository<PolicyHistory>,

        @InjectRepository(Employee)
        private readonly employeeRepo: Repository<Employee>,

        private readonly fcmService: FcmService,

        private readonly policyGateway: PolicyGateway,
        private dataSource: DataSource,

        private employeeFcmTokenService:
            EmployeeFcmTokenService,
        private readonly notificationService: NotificationService,
    ) { }

    // ✅ CREATE
    async create(dto: CreatePolicyDto): Promise<Policy> {
        const subject = await this.subjectRepo.findOne({
            where: { id: dto.subjectId },
            relations: [
                'school',
                'school.ward',
                'school.ward.province',
            ],
        });

        if (!subject) {
            throw new NotFoundException(
                'Subject không tồn tại',
            );
        }

        const subjectYear = normalizeYear(
            subject.schoolYear,
        );

        const compareYear =
            normalizeYear('2026-2027');

        const isSummer =
            subject.schoolYear?.includes('Hè');

        // ================= BASE APPROVED =================

        const approvedPolicy =
            await this.policyRepo.findOne({
                where: {
                    subjectId: dto.subjectId,
                    status:
                        PolicyStatus.DIRECTOR_APPROVED,
                },

                order: {
                    createdAt: 'DESC',
                },
            });

        const baseData =
            approvedPolicy?.data ?? null;

        const diff = baseData
            ? getDiff(baseData, dto.data)
            : null;

        // ================= DETERMINE STATUS =================

        const isAutoApproved =
            !isSummer &&
            subjectYear < compareYear;

        const finalStatus: PolicyStatus =
            isAutoApproved
                ? PolicyStatus.DIRECTOR_APPROVED
                : dto.status ??
                PolicyStatus.DRAFT;

        // ================= SAVE POLICY =================

        const policy = this.policyRepo.create({
            subjectId: dto.subjectId,
            data: dto.data,
            status: finalStatus,
            durationMonths:
                dto.durationMonths ?? 0,
        });

        const saved =
            await this.policyRepo.save(policy);

        // ================= NOTIFICATION =================

        if (
            !isAutoApproved &&
            finalStatus ===
            PolicyStatus.PENDING
        ) {
            const employees =
                await this.employeeRepo.createQueryBuilder('e')
                    .where(`e.roles && ARRAY[:...roles]::text[]`, {
                        roles: ['saleadmin', 'salesadmin_la', 'director', 'director_la'],
                    })
                    .getMany();

            const userIds = employees
                .map((e) => e.id)
                .filter(
                    (
                        id,
                    ): id is number =>
                        id !== undefined,
                );

            const tokenEntities =
                await this.employeeFcmTokenService
                    .getTokens(userIds);

            const tokens =
                tokenEntities.map(
                    (x) => x.token,
                );

            console.log(
                'FCM TOKENS:',
                tokens,
            );

            const name = fixVietnamese(
                dto.employeeInfo?.name || '',
            );

            const message = `${name} đã gửi yêu cầu duyệt chính sách môn ${subject.name} năm học ${subject.schoolYear}`;

            const meta = {
                regionName:
                    subject.school?.ward
                        ?.province?.name,

                schoolName:
                    subject.school?.name,

                subjectName: subject.name,

                schoolYear:
                    subject.schoolYear,
            };

            // ===== PUSH NOTIFICATION =====

            if (tokens.length > 0) {
                await this.fcmService.sendToMultiple(
                    tokens,
                    '📄 Có yêu cầu duyệt chính sách',
                    message,
                    {
                        type: 'policy',

                        id: String(saved.id),

                        subjectId: String(
                            saved.subjectId,
                        ),

                        url: `/director`,
                    },
                );
            }

            // ===== SAVE DATABASE NOTIFICATION =====

            const notifications =
                await this.notificationService.createNotifications(
                    {
                        receiverIds: userIds,

                        type:
                            NotificationType.POLICY,

                        entityId: saved.id,

                        message,

                        senderId:
                            dto.employeeInfo
                                ?.sub,

                        meta,
                    },
                );

            // ===== SOCKET REALTIME =====

            notifications.forEach(
                (noti) => {
                    this.policyGateway.server
                        .to(
                            `user_${noti.receiverId}`,
                        )
                        .emit(
                            'notification:new',
                            {
                                id: noti.id,

                                type: noti.type,

                                entityId:
                                    noti.entityId,

                                message:
                                    noti.message,

                                isRead:
                                    noti.isRead,

                                createdAt:
                                    noti.createdAt,

                                subjectId:
                                    saved.subjectId,

                                createdBy:
                                    dto.employeeInfo
                                        ?.sub,

                                meta,
                            },
                        );
                },
            );
        }

        // ================= HISTORY =================

        const history =
            await this.historyRepo.save({
                policyId: saved.id,

                updatedBy:
                    dto.employeeInfo?.name ||
                    'unknown',

                action: isAutoApproved
                    ? 'AUTO_APPROVED'
                    : finalStatus ===
                        PolicyStatus.DRAFT
                        ? 'SAVE_DRAFT'
                        : 'CREATE',

                oldData: baseData,

                newData: dto.data,

                diff,

                status: finalStatus,
            });

        // ================= LINK CURRENT HISTORY =================

        await this.policyRepo.update(
            saved.id,
            {
                currentHistoryId:
                    history.id,
            },
        );

        return saved;
    }
    // ✅ GET ALL
    async findAll(): Promise<Policy[]> {
        return await this.policyRepo.find({
            order: { createdAt: 'DESC' },
        });
    }

    // ==========================================================
    // ✅ DANH SÁCH TỔNG HỢP CHO DIRECTOR / SALE ADMIN
    // ==========================================================

    /**
     * Base query dùng chung cho list + filter-options.
     * Toàn bộ join là many-to-one nên 1 policy = 1 dòng, không cần DISTINCT.
     */
    private buildScopedPolicyQuery(scope: PolicyScope): SelectQueryBuilder<Policy> {
        const qb = this.policyRepo
            .createQueryBuilder('p')
            .innerJoin('p.subject', 'sub')
            .innerJoin('sub.school', 'sc')
            .leftJoin('sc.employee', 'e')
            .leftJoin('sc.ward', 'w')
            .leftJoin('w.province', 'pr');

        // 🔒 Phạm vi dữ liệu lấy từ token, KHÔNG từ query param.
        if (scope.kind === 'province') {
            qb.andWhere('pr.id = :scopeProvinceId', {
                scopeProvinceId: scope.provinceId,
            });
        }

        if (scope.kind === 'own') {
            qb.andWhere('sc.employee_id = :scopeEmployeeId', {
                scopeEmployeeId: scope.employeeId,
            });
        }

        return qb;
    }

    private applyPolicyFilters(
        qb: SelectQueryBuilder<Policy>,
        query: PolicyFilters,
    ): SelectQueryBuilder<Policy> {
        if (query.status) {
            qb.andWhere('p.status = :status', { status: query.status });
        }

        if (query.schoolId) {
            qb.andWhere('sc.id = :schoolId', { schoolId: query.schoolId });
        }

        if (query.subjectId) {
            qb.andWhere('sub.id = :subjectId', { subjectId: query.subjectId });
        }

        if (query.schoolYear) {
            qb.andWhere('sub.schoolYear = :schoolYear', {
                schoolYear: query.schoolYear,
            });
        }

        if (query.employeeId) {
            qb.andWhere('sc.employee_id = :employeeId', {
                employeeId: query.employeeId,
            });
        }

        // Cột created_at là `timestamp without time zone` lưu giờ hệ thống,
        // nên so sánh bằng chuỗi giờ local là đúng timezone hệ thống.
        if (query.fromDate) {
            qb.andWhere('p.createdAt >= :fromDate', {
                fromDate: `${query.fromDate} 00:00:00.000`,
            });
        }

        if (query.toDate) {
            qb.andWhere('p.createdAt <= :toDate', {
                toDate: `${query.toDate} 23:59:59.999`,
            });
        }

        if (query.search) {
            const term = `%${escapeLike(query.search.toLowerCase())}%`;

            qb.andWhere(
                new Brackets((b) => {
                    b.where('LOWER(sc.name) LIKE :searchTerm', { searchTerm: term })
                        .orWhere('LOWER(sub.name) LIKE :searchTerm', { searchTerm: term })
                        .orWhere('LOWER(e.name) LIKE :searchTerm', { searchTerm: term })
                        .orWhere('LOWER(sub.contractNumber) LIKE :searchTerm', {
                            searchTerm: term,
                        });
                }),
            );
        }

        return qb;
    }

    private assertValidDateRange(query: PolicyFilters): void {
        if (query.fromDate && query.toDate && query.fromDate > query.toDate) {
            throw new BadRequestException('fromDate phải nhỏ hơn hoặc bằng toDate');
        }
    }

    /**
     * GET /policies/all — contract FE chốt cho tab "Tất cả chính sách":
     * limit mặc định 12, wrapper `pagination`, field tiền tố `policy*`,
     * sắp xếp cố định createdAt DESC rồi id DESC.
     */
    async findAllPaginated(
        query: QueryPoliciesPageDto,
        scope: PolicyScope,
    ): Promise<PolicyPageResponse> {
        this.assertValidDateRange(query);

        // Clamp lại ở service để gọi trực tiếp (không qua ValidationPipe) vẫn an toàn.
        const page = clampPage(query.page);
        const limit = clampLimit(query.limit);

        const qb = this.applyPolicyFilters(
            this.buildScopedPolicyQuery(scope),
            query,
        );

        const total = await qb.getCount();

        const rows = await qb
            .select([
                'p.id AS "policyId"',
                'p.status AS "policyStatus"',
                'p.createdAt AS "policyCreatedAt"',

                'sc.id AS "schoolId"',
                'sc.name AS "schoolName"',

                'sub.id AS "subjectId"',
                'sub.name AS "subjectName"',
                'sub.schoolYear AS "schoolYear"',

                'sc.employee_id AS "employeeId"',
                'e.name AS "employeeName"',
            ])
            .orderBy('p.createdAt', 'DESC')
            .addOrderBy('p.id', 'DESC')
            .limit(limit)
            .offset((page - 1) * limit)
            .getRawMany();

        return {
            data: rows.map((row) => this.toPolicyPageItem(row)),
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    private toPolicyPageItem(row: Record<string, any>): PolicyPageItem {
        return {
            policyId: Number(row.policyId),
            policyStatus: row.policyStatus,
            policyCreatedAt: toIsoString(row.policyCreatedAt)!,

            schoolId: Number(row.schoolId),
            schoolName: row.schoolName,

            subjectId: Number(row.subjectId),
            subjectName: row.subjectName,
            schoolYear: row.schoolYear ?? null,

            employeeId: toNumberOrNull(row.employeeId),
            employeeName: row.employeeName ?? null,
        };
    }

    async findAllForAdmin(
        query: QueryPoliciesDto,
        scope: PolicyScope,
    ): Promise<PolicyListResponse> {
        this.assertValidDateRange(query);

        const page = query.page ?? 1;
        const limit = Math.min(query.limit ?? 20, POLICY_LIST_MAX_LIMIT);
        const sortBy = query.sortBy ?? 'createdAt';
        const sortOrder = query.sortOrder === 'asc' ? 'ASC' : 'DESC';

        const qb = this.applyPolicyFilters(
            this.buildScopedPolicyQuery(scope),
            query,
        );

        // Đếm trước khi gắn LIMIT/OFFSET; TypeORM tự clone nên qb không bị ảnh hưởng.
        const total = await qb.getCount();

        const rows = await qb
            .select([
                'p.id AS "policyId"',
                'p.status AS "status"',
                'p.createdAt AS "createdAt"',
                'p.updatedAt AS "updatedAt"',
                'p.data AS "policyData"',
                'p.currentHistoryId AS "currentHistoryId"',

                'sc.employee_id AS "employeeId"',
                'e.name AS "employeeName"',

                'sc.id AS "schoolId"',
                'sc.name AS "schoolName"',

                'sub.id AS "subjectId"',
                'sub.name AS "subjectName"',
                'sub.schoolYear AS "schoolYear"',
                'sub.contractNumber AS "contractNumber"',
                'sub.studentCount AS "studentCount"',
                'sub.totalLessons AS "totalLessons"',
            ])
            .orderBy(POLICY_SORT_COLUMNS[sortBy], sortOrder)
            // Tie-breaker để phân trang ổn định khi cột sort trùng giá trị.
            .addOrderBy('p.id', 'DESC')
            .limit(limit)
            .offset((page - 1) * limit)
            .getRawMany();

        const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

        return {
            data: rows.map((row) => this.toPolicyListItem(row)),
            meta: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
        };
    }

    private toPolicyListItem(row: Record<string, any>): PolicyListItem {
        return {
            policyId: Number(row.policyId),
            status: row.status,
            createdAt: toIsoString(row.createdAt)!,
            updatedAt: toIsoString(row.updatedAt) ?? toIsoString(row.createdAt)!,

            employeeId: toNumberOrNull(row.employeeId),
            employeeName: row.employeeName ?? null,

            schoolId: Number(row.schoolId),
            schoolName: row.schoolName,

            subjectId: Number(row.subjectId),
            subjectName: row.subjectName,

            schoolYear: row.schoolYear ?? null,
            contractNumber: row.contractNumber ?? null,

            studentCount: toNumberOrNull(row.studentCount),
            totalLessons: toNumberOrNull(row.totalLessons),

            policyData: row.policyData ?? null,

            currentHistoryId: toNumberOrNull(row.currentHistoryId),
        };
    }

    /** Tùy chọn bộ lọc — chỉ gồm dữ liệu nằm trong phạm vi user được xem. */
    async getFilterOptions(scope: PolicyScope): Promise<PolicyFilterOptions> {
        const [schools, subjects, schoolYearRows, employees] = await Promise.all([
            this.buildScopedPolicyQuery(scope)
                .select(['sc.id AS "id"', 'sc.name AS "name"'])
                .groupBy('sc.id')
                .addGroupBy('sc.name')
                .orderBy('sc.name', 'ASC')
                .getRawMany(),

            this.buildScopedPolicyQuery(scope)
                .select(['sub.id AS "id"', 'sub.name AS "name"'])
                .groupBy('sub.id')
                .addGroupBy('sub.name')
                .orderBy('sub.name', 'ASC')
                .addOrderBy('sub.id', 'ASC')
                .getRawMany(),

            this.buildScopedPolicyQuery(scope)
                .select('sub.schoolYear', 'schoolYear')
                .andWhere('sub.schoolYear IS NOT NULL')
                .groupBy('sub.schoolYear')
                .getRawMany(),

            this.buildScopedPolicyQuery(scope)
                .select(['e.id AS "id"', 'e.name AS "name"'])
                .andWhere('e.id IS NOT NULL')
                .groupBy('e.id')
                .addGroupBy('e.name')
                .orderBy('e.name', 'ASC')
                .getRawMany(),
        ]);

        return {
            statuses: Object.values(PolicyStatus).map((value) => ({
                value,
                label: POLICY_STATUS_LABELS[value],
            })),
            schools: schools.map((s) => ({ id: Number(s.id), name: s.name })),
            subjects: subjects.map((s) => ({ id: Number(s.id), name: s.name })),
            schoolYears: schoolYearRows
                .map((row) => row.schoolYear as string)
                .sort((a, b) => {
                    // Năm mới nhất trước; cùng năm thì năm học chính trước "Hè".
                    const startYear = (value: string) =>
                        Number(value.match(/\d{4}/)?.[0] ?? 0);
                    return startYear(b) - startYear(a) || a.localeCompare(b);
                }),
            employees: employees.map((e) => ({
                id: Number(e.id),
                name: e.name ?? null,
            })),
        };
    }

    // ✅ GET ONE
    async findOne(id: number): Promise<Policy> {
        const policy = await this.policyRepo.findOne({
            where: { id },
            relations: ['subject'],
        });

        if (!policy) {
            throw new NotFoundException('Policy không tồn tại');
        }

        return policy;
    }

    async findBySubject(subjectId: number): Promise<Policy[]> {
        return await this.policyRepo.find({
            where: { subjectId },
            order: { createdAt: 'DESC' },
        });
    }

    async update(id: number, dto: UpdatePolicyDto): Promise<Policy> {
        const subject = await this.subjectRepo.findOne({
            where: { id: dto.subjectId },
            relations: [
                'school',
                'school.ward',
                'school.ward.province',
            ],
        });

        if (!subject) {
            throw new NotFoundException('Subject không tồn tại');
        }

        return await this.dataSource.transaction(async (manager) => {
            const policyRepo = manager.getRepository(Policy);
            const historyRepo = manager.getRepository(PolicyHistory);

            const policy = await policyRepo.findOne({ where: { id } });
            if (!policy) {
                throw new Error("Policy not found");
            }

            const subjectYear = normalizeYear(subject.schoolYear);
            const compareYear = normalizeYear('2026-2027');
            const isSummer = subject.schoolYear?.includes('Hè');

            // CASE AUTO APPROVED (giữ nguyên logic cũ)
            if (!isSummer && subjectYear < compareYear) {
                const saved = await policyRepo.save({
                    data: dto.data,
                    subjectId: dto.subjectId,
                    status: PolicyStatus.DIRECTOR_APPROVED
                });

                await policyRepo
                    .createQueryBuilder()
                    .update()
                    .set({
                        status: PolicyStatus.REJECTED,
                        note: 'Tự động từ chối do đã có chính sách khác được duyệt',
                    })
                    .where('subjectId = :subjectId', { subjectId: policy.subjectId })
                    .andWhere('id != :id', { id: policy.id })
                    .execute();

                return saved;
            }

            const newData = dto.data;
            const currentData = JSON.parse(JSON.stringify(policy.data));

            // Không thay đổi gì → return luôn
            if (JSON.stringify(currentData) === JSON.stringify(newData)) {
                return policy;
            }

            const approvedPolicy = await policyRepo.findOne({
                where: {
                    subjectId: policy.subjectId,
                    status: PolicyStatus.DIRECTOR_APPROVED,
                },
                order: { createdAt: 'DESC' },
            });

            let baseData = null;

            if (approvedPolicy) {
                baseData = approvedPolicy.data;
            }
            let diff = null;

            if (approvedPolicy) {
                baseData = approvedPolicy.data;
                diff = getDiff(baseData, newData);
            }

            // ✅ SET STATUS TỪ DTO (fallback = DRAFT)
            policy.data = newData;
            policy.status = dto.status ?? PolicyStatus.DRAFT;
            policy.durationMonths = dto.durationMonths || 0;
            // Save history
            const history = await historyRepo.save({
                policyId: policy.id,
                updatedBy: dto.employeeInfo?.name || 'unknown',
                action: 'UPDATE',
                oldData: baseData,
                newData,
                diff,
                status: dto.status
            });

            policy.currentHistoryId = history.id;

            // ✅ SAVE POLICY TRƯỚC
            const saved = await policyRepo.save(policy);

            // ==============================
            // ✅ CHỈ GỬI NOTIFY KHI PENDING
            // ==============================
            if (dto.status === PolicyStatus.PENDING) {
                const employees = await this.employeeRepo.createQueryBuilder('e')
                    .where(`e.roles && ARRAY[:...roles]::text[]`, {
                        roles: ['saleadmin', 'salesadmin_la', 'director', 'director_la'],
                    })
                    .getMany();

                const userIds = employees
                    .map(e => e.id)
                    .filter((id): id is number => id !== undefined);

                const tokenEntities = await this.employeeFcmTokenService.getTokens(userIds);
                const tokens = tokenEntities.map((x) => x.token);

                const name = fixVietnamese(String(dto.employeeInfo?.name));

                // 🔔 FCM
                if (tokens.length > 0) {
                    await this.fcmService.sendToMultiple(
                        tokens,
                        "📄 Có yêu cầu duyệt chính sách",
                        `${name} đã gửi yêu cầu duyệt chính sách môn ${subject.name} năm học ${subject.schoolYear}`,
                        {
                            type: "policy",
                            id: String(dto.subjectId),
                            url: `/director/policy/${saved.id}`,
                        }
                    );
                }

                // 🔔 DB Notification
                const message = `${name} đã gửi yêu cầu duyệt chính sách môn ${subject.name} năm học ${subject.schoolYear}`;
                const meta = {
                    regionName: subject.school?.ward?.province?.name,
                    schoolName: subject.school?.name,
                    subjectName: subject.name,
                    schoolYear: subject.schoolYear,
                };
                const notifications = await this.notificationService.createNotifications({
                    receiverIds: userIds,
                    type: NotificationType.POLICY,
                    entityId: saved.id,
                    message,
                    senderId: dto.employeeInfo?.sub,
                    meta,
                });

                // 🔔 Socket realtime
                notifications.forEach(noti => {
                    this.policyGateway.server
                        .to(`user_${noti.receiverId}`)
                        .emit("notification:new", {
                            id: noti.id,
                            type: noti.type,
                            entityId: noti.entityId,
                            message: noti.message,
                            isRead: noti.isRead,
                            createdAt: noti.createdAt,
                            meta,
                            createdBy: dto.employeeInfo?.sub,
                        });
                });
            }

            return saved;
        });
    }
    async findHistoryByCurrentHistoryId(historyId: number): Promise<PolicyHistory> {
        const history = await this.historyRepo.findOne({
            where: { id: historyId },
            relations: ['policy'],
        });

        if (!history) {
            throw new NotFoundException('Không tìm thấy history');
        }

        return history;
    }
    // ✅ DELETE
    async remove(id: number): Promise<void> {
        const policy = await this.findOne(id);
        await this.policyRepo.remove(policy);
    }

    async adminUpdateStatusNote(
        id: number,
        dto: AdminUpdatePolicyDto,
        reviewer?: {
            id: number;
            name?: string;
            role: 'director' | 'salesadmin';
        },
    ) {
        const policy = await this.policyRepo.findOne({
            where: { id },
        });
        const subject = await this.subjectRepo.findOne({
            where: { id: dto.subjectId },
            relations: [
                'school',
                'school.ward',
                'school.ward.province',
            ],
        });

        if (!subject) {
            throw new NotFoundException('Subject không tồn tại');
        }
        if (!policy) {
            throw new NotFoundException('Policy not found');
        }
        if (policy.status === PolicyStatus.DIRECTOR_APPROVED) {
            throw new BadRequestException(
                'Chính sách đã được giám đốc duyệt, không thể chỉnh sửa',
            );
        }
        if (!dto.status) {
            throw new BadRequestException('Status không được để trống');
        }
        const meta = {
            regionName: subject.school?.ward?.province?.name,
            schoolName: subject.school?.name,
            subjectName: subject.name,
            schoolYear: subject.schoolYear,
        };
        policy.status = dto.status;
        policy.note = dto.note;

        // Phân biệt rõ vai trò thực hiện trong lịch sử. Không dùng chung
        // ADMIN_UPDATE vì khi xem lại sẽ không biết ai đã duyệt/từ chối.
        const history = await this.historyRepo.save({
            policyId: policy.id,
            status: dto.status,
            note: dto.note,
            action:
                reviewer?.role === 'salesadmin'
                    ? 'SALES_ADMIN_UPDATE'
                    : 'DIRECTOR_UPDATE',
            updatedBy: reviewer?.name || 'Quản trị viên',
        });
        policy.currentHistoryId = history.id;

        // Giám đốc duyệt/từ chối là quyết định CUỐI cho lần gửi duyệt này —
        // đánh dấu đã đọc cho TẤT CẢ người nhận ban đầu (saleadmin, director,
        // ketoan...), không riêng người vừa thao tác. Sale Admin kiểm duyệt
        // chỉ là bước TRUNG GIAN (giám đốc vẫn cần tự thấy "cần duyệt" để
        // quyết định), nên chỉ đánh dấu cho đúng người vừa kiểm duyệt. Đánh
        // dấu TRƯỚC khi tạo thông báo kết quả bên dưới (cùng type+entityId)
        // để không lỡ tay đánh dấu luôn thông báo kết quả vừa tạo.
        if (reviewer?.role === 'director') {
            await this.notificationService.markAllAsReadByTypeAndEntity(
                NotificationType.POLICY,
                policy.id,
            );
        } else if (reviewer?.id) {
            await this.notificationService.markAsReadByTypeEntityForReceiver(
                NotificationType.POLICY,
                policy.id,
                reviewer.id,
            );
        }

        if (dto.status === PolicyStatus.DIRECTOR_APPROVED) {
            const employee = await this.employeeRepo.findOne({
                where: { id: dto.userId },
            });

            const tokenEntities =
                await this.employeeFcmTokenService.getTokens([
                    dto.userId,
                ]);

            const tokens = tokenEntities.map(
                (x) => x.token,
            );

            if (tokens.length > 0) {
                await this.fcmService.sendToMultiple(
                    tokens,
                    '📄 Chính sách đã được duyệt',
                    `Giám đốc đã duyệt chính sách môn ${subject.name} năm học ${subject.schoolYear} của bạn`,
                    {
                        type: 'policy',
                        id: String(policy.id),
                        subjectId: String(dto.subjectId),
                        url: `/employee/policy/${policy.id}`,
                    },
                );
            }
            if (!employee) {
                throw new NotFoundException('Employee not found');
            }

            const message = `Giám đốc đã duyệt chính sách môn ${subject.name} năm học ${subject.schoolYear} của bạn`;

            const notifications = await this.notificationService.createNotifications({
                receiverIds: [dto.userId],
                type: NotificationType.POLICY,
                entityId: policy.id,
                message,
                senderId: dto.userId,
                meta,
            });
            notifications.forEach(noti => {
                this.policyGateway.server
                    .to(`user_${noti.receiverId}`)
                    .emit("notification:new", {
                        id: noti.id,
                        type: noti.type,
                        entityId: noti.entityId,
                        message: noti.message,
                        isRead: noti.isRead,
                        createdAt: noti.createdAt,
                        meta,
                        createdBy: employee.name,
                    });
            });

            await this.policyRepo
                .createQueryBuilder()
                .update()
                .set({
                    status: PolicyStatus.REJECTED,
                    note: 'Tự động từ chối do đã có chính sách khác được duyệt',
                })
                .where('subjectId = :subjectId', { subjectId: policy.subjectId })
                .andWhere('id != :id', { id: policy.id })
                .execute();
        }
        if (dto.status === PolicyStatus.SALE_ADMIN_APPROVED) {
            const employee = await this.employeeRepo.findOne({
                where: { id: dto.userId },
            });
            const directors = await this.employeeRepo.createQueryBuilder('e')
                .where(`e.roles && ARRAY[:...roles]::text[]`, {
                    roles: ['director', 'director_la'],
                })
                .getMany();
            const tokenEntities =
                await this.employeeFcmTokenService.getTokens([
                    dto.userId,
                ]);

            const tokens = tokenEntities.map(
                (x) => x.token,
            );

            if (tokens.length > 0) {
                await this.fcmService.sendToMultiple(
                    tokens,
                    '📄 Chính sách đã được kiểm tra',
                    `Sale admin đã kiểm tra chính sách môn ${subject.name} năm học ${subject.schoolYear} của bạn`,
                    {
                        type: 'policy',
                        id: String(policy.id),
                        subjectId: String(dto.subjectId),
                        url: `/employee/policy/${policy.id}`,
                    },
                );
            }
            if (!employee) {
                throw new NotFoundException('Employee not found');
            }
            if (!directors) {
                throw new NotFoundException('Director not found');
            }
            const name = fixVietnamese(String(employee.name))
            const message = `Sale admin đã kiểm tra chính sách môn ${subject.name} năm học ${subject.schoolYear} của bạn`;
            const messageD = `Sale admin đã kiểm tra chính sách môn ${subject.name} năm học ${subject.schoolYear} của ${name}`;
            const notifications = await this.notificationService.createNotifications({
                receiverIds: [dto.userId],
                type: NotificationType.POLICY,
                entityId: policy.id,
                message,
                senderId: dto.userId,
                meta,
            });
            const directorIds = directors
                .map(d => d.id)
                .filter((id): id is number => id !== undefined);
            const notificationsD = await this.notificationService.createNotifications({
                receiverIds: directorIds,
                type: NotificationType.POLICY,
                entityId: policy.id,
                message: messageD,
                senderId: dto.userId,
                meta,
            });
            notifications.forEach(noti => {
                this.policyGateway.server
                    .to(`user_${noti.receiverId}`)
                    .emit("notification:new", {
                        id: noti.id,
                        type: noti.type,
                        entityId: noti.entityId,
                        message: noti.message,
                        isRead: noti.isRead,
                        createdAt: noti.createdAt,
                        subjectId: dto.subjectId,
                        createdBy: dto.userId,
                        meta
                    });
            });
            notificationsD.forEach(noti => {
                this.policyGateway.server
                    .to(`user_${noti.receiverId}`)
                    .emit("notification:new", {
                        id: noti.id,
                        type: noti.type,
                        entityId: noti.entityId,
                        message: noti.message,
                        isRead: noti.isRead,
                        createdAt: noti.createdAt,
                        subjectId: dto.subjectId,
                        createdBy: dto.userId,
                        meta
                    });
            });
            //-----------------------


        }
        return this.policyRepo.save(policy);
    }

    async directorUpdatePolicy(
        policyId: number,
        dto: DirectorUpdatePolicyDto,
        director: { id: number; name?: string },
    ) {
        return this.updatePolicyByReviewer(policyId, dto, director, {
            defaultName: 'Giám đốc',
            historyAction: 'DIRECTOR_UPDATE',
        });
    }

    async salesAdminUpdatePolicy(
        policyId: number,
        dto: DirectorUpdatePolicyDto,
        salesAdmin: { id: number; name?: string },
    ) {
        return this.updatePolicyByReviewer(policyId, dto, salesAdmin, {
            defaultName: 'Sale admin',
            historyAction: 'SALES_ADMIN_UPDATE',
        });
    }

    private async updatePolicyByReviewer(
        policyId: number,
        dto: DirectorUpdatePolicyDto,
        reviewer: { id: number; name?: string },
        options: {
            defaultName: string;
            historyAction: 'DIRECTOR_UPDATE' | 'SALES_ADMIN_UPDATE';
        },
    ) {
        return await this.dataSource.transaction(async (manager) => {
            const policyRepo = manager.getRepository(Policy);
            const historyRepo = manager.getRepository(PolicyHistory);

            const policy = await policyRepo.findOne({
                where: { id: policyId },
                relations: ['subject'],
            });

            if (!policy) {
                throw new NotFoundException('Policy không tồn tại');
            }

            const subject = await this.subjectRepo.findOne({
                where: { id: policy.subjectId },
                relations: [
                    'school',
                    'school.ward',
                    'school.ward.province',
                ],
            });

            if (!subject) {
                throw new NotFoundException('Subject không tồn tại');
            }

            const employee = await this.employeeRepo.findOne({
                where: { id: dto.employeeId },
            });

            if (!employee) {
                throw new NotFoundException('Employee không tồn tại');
            }

            const oldData = JSON.parse(JSON.stringify(policy.data));
            const newData = dto.data;
            const diff = getDiff(oldData, newData);

            policy.data = newData;
            if (dto.durationMonths !== undefined) {
                policy.durationMonths = dto.durationMonths;
            }

            const history = await historyRepo.save({
                policyId: policy.id,
                updatedBy: reviewer.name || options.defaultName,
                action: options.historyAction,
                oldData,
                newData,
                diff,
                note: dto.note,
                status: policy.status,
            });

            policy.currentHistoryId = history.id;
            await policyRepo.save(policy);

            // ===== THÔNG BÁO ĐẾN EMPLOYEE =====

            const reviewerName = fixVietnamese(
                reviewer.name || options.defaultName,
            );
            const message = `${reviewerName} đã chỉnh sửa chính sách môn ${subject.name} năm học ${subject.schoolYear}`;

            const meta = {
                regionName: subject.school?.ward?.province?.name,
                schoolName: subject.school?.name,
                subjectName: subject.name,
                schoolYear: subject.schoolYear,
            };

            // FCM Push
            const tokenEntities =
                await this.employeeFcmTokenService.getTokens([dto.employeeId]);
            const tokens = tokenEntities.map((x) => x.token);

            if (tokens.length > 0) {
                await this.fcmService.sendToMultiple(
                    tokens,
                    '📄 Chính sách đã được chỉnh sửa',
                    message,
                    {
                        type: 'policy',
                        id: String(policy.id),
                        subjectId: String(policy.subjectId),
                        url: `/employee/policy/${policy.id}`,
                    },
                );
            }

            // DB Notification
            const notifications =
                await this.notificationService.createNotifications({
                    receiverIds: [dto.employeeId],
                    type: NotificationType.POLICY,
                    entityId: policy.id,
                    message,
                    senderId: reviewer.id,
                    meta,
                });

            // Socket Realtime
            notifications.forEach((noti) => {
                this.policyGateway.server
                    .to(`user_${noti.receiverId}`)
                    .emit('notification:new', {
                        id: noti.id,
                        type: noti.type,
                        entityId: noti.entityId,
                        message: noti.message,
                        isRead: noti.isRead,
                        createdAt: noti.createdAt,
                        subjectId: policy.subjectId,
                        createdBy: reviewer.id,
                        meta,
                    });
            });

            // Trả về lịch sử để FE xem diff
            const histories = await historyRepo.find({
                where: { policyId: policy.id },
                order: { createdAt: 'DESC' },
            });

            return {
                policy,
                histories,
            };
        });
    }

    async getHistoryBySubject(subjectId: number) {
        const policies = await this.policyRepo.find({
            where: { subjectId },
        });

        const ids = policies.map(p => p.id);

        return this.historyRepo.find({
            where: {
                policy: { id: In(ids) },
            },
            order: { createdAt: 'DESC' },
        });
    }
    async getHistoryByPolicy(policyId: number) {
        return this.historyRepo.find({
            where: { policy: { id: policyId } },
            order: { createdAt: 'DESC' },
        });
    }
    async getApprovedPolicy(policyId: number) {
        return this.historyRepo.findOne({
            where: {
                policy: { id: policyId },
                status: PolicyStatus.DIRECTOR_APPROVED,
            },
            order: {
                createdAt: 'DESC',
            },
        });
    }

    async getStats(employeeId: number, allStatuses?: boolean) {
        const qb = this.policyRepo
            .createQueryBuilder('p')

            // ===== JOIN =====
            .innerJoin('p.subject', 'sub')
            .innerJoin('sub.school', 's')
            .leftJoin('s.ward', 'w')
            .leftJoin('w.province', 'pr')

            // ===== SELECT =====
            .select([
                // POLICY
                'p.id AS "policyId"',
                'p.status AS "policyStatus"',
                'p.data AS "policyData"',
                'p.createdAt AS "policyCreatedAt"',
                // Nhân viên sửa và gửi duyệt lại chính sách CŨ thì `createdAt`
                // vẫn giữ nguyên từ lần tạo đầu tiên — phải dùng `updatedAt`
                // (tự cập nhật mỗi lần save) mới xác định đúng chính sách nào
                // vừa được thao tác gần nhất.
                'p.updatedAt AS "policyUpdatedAt"',

                // SUBJECT
                'sub.id AS "subjectId"',
                'sub.name AS "subjectName"',
                'sub.student_count AS "studentCount"',
                'sub.total_lessons AS "totalLessons"',
                'sub.contract_number AS "contractNumber"',
                'sub.contract_years AS "contractYears"',
                'sub.appendix_years AS "appendixYears"',
                'sub.start_date AS "startDate"',
                'sub.school_year AS "schoolYear"',

                // SCHOOL
                's.id AS "schoolId"',
                's.name AS "schoolName"',
                's.address AS "schoolAddress"',
                's.representative AS "representative"',
                's.scale AS "scale"',
                's.tax_code AS "taxCode"',
                's.phone AS "phone"',
                's.employee_id AS "employeeId"',
                's.class_count AS "classCount"',
                's.ward_id AS "wardId"',

                // LOCATION
                'w.id AS "wardId"',
                'w.name AS "wardName"',
                'pr.id AS "provinceId"',
                'pr.name AS "provinceName"',
            ])

            // ===== WHERE =====
            .andWhere('s.employee_id = :employeeId', { employeeId });

        if (!allStatuses) {
            qb.andWhere('p.status = :status', { status: 'DIRECTOR_APPROVED' });
        }

        return await qb
            // ===== ORDER =====
            .orderBy('pr.id', 'ASC')
            .addOrderBy('w.id', 'ASC')
            .addOrderBy('s.id', 'ASC')
            .addOrderBy('sub.id', 'ASC')
            .addOrderBy('p.id', 'DESC')

            // ===== RESULT =====
            .getRawMany();
    }
    async getStatsBySchool({
        schoolId,
        subjectId,
        schoolYear,
    }: {
        schoolId: number;
        subjectId?: number;
        schoolYear?: string;
    }) {
        const qb = this.policyRepo
            .createQueryBuilder('p')
            .innerJoin('p.subject', 'sub')
            .innerJoin('sub.school', 's')
            .leftJoin('s.ward', 'w')
            .leftJoin('w.province', 'pr')

            .where('p.status = :status', {
                status: 'DIRECTOR_APPROVED',
            })
            .andWhere('s.id = :schoolId', { schoolId });

        // ===== FILTER =====
        if (subjectId) {
            qb.andWhere('sub.id = :subjectId', { subjectId });
        }

        if (schoolYear) {
            qb.andWhere('sub.school_year = :schoolYear', { schoolYear });
        }

        const rows = await qb
            .select([
                // ===== POLICY =====
                'p.id AS "policyId"',
                'p.data AS "policyData"',
                'p.created_at AS "policyCreatedAt"',

                // ===== SUBJECT =====
                'sub.id AS "subjectId"',
                'sub.name AS "subjectName"',
                'sub.student_count AS "studentCount"',
                'sub.total_lessons AS "totalLessons"',
                'sub.contract_number AS "contractNumber"',
                'sub.contract_years AS "contractYears"',
                'sub.appendix_years AS "appendixYears"',
                'sub.start_date AS "startDate"',
                'sub.school_year AS "schoolYear"',

                // (optional)
                's.id AS "schoolId"',
                's.name AS "schoolName"',
                's.address AS "schoolAddress"',
                's.representative AS "representative"',
                's.scale AS "scale"',
                's.tax_code AS "taxCode"',
                's.phone AS "phone"',
                's.employee_id AS "employeeId"',
                's.class_count AS "classCount"',
                's.ward_id AS "wardId"',

            ])
            .orderBy('p.id', 'DESC')
            .getRawMany();

        return rows;
    }
}
