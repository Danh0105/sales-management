import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PolicyYear } from './entities/policy-year.entity';
import { PolicyYearSubject } from './entities/policy-year-subject.entity';
import { PolicyYearMonthlyRow } from './entities/policy-year-monthly-row.entity';
import { PolicyYearStatus } from './policy-year.enum';
import { UpsertPolicyYearDto } from './dto/upsert-policy-year.dto';
import { School } from '../school/schools.entity';

@Injectable()
export class PolicyYearService {
    constructor(
        @InjectRepository(PolicyYear)
        private readonly repo: Repository<PolicyYear>,

        @InjectRepository(School)
        private readonly schoolRepo: Repository<School>,

        private readonly dataSource: DataSource,
    ) { }

    async upsert(dto: UpsertPolicyYearDto) {
        const [y1, y2] = dto.schoolYear.split('-').map(Number);
        if (y2 !== y1 + 1) {
            throw new BadRequestException(
                'Năm học không hợp lệ: năm sau phải bằng năm trước + 1',
            );
        }

        const school = await this.schoolRepo.findOne({
            where: { id: dto.schoolId },
        });
        if (!school) {
            throw new NotFoundException('Trường không tồn tại');
        }

        const subjects = dto.subjects ?? [];
        const monthlyRows = dto.monthlyRows ?? [];

        const subjectIds = new Set(subjects.map((s) => s.id));
        for (const row of monthlyRows) {
            if (!subjectIds.has(row.subjectId)) {
                throw new BadRequestException(
                    `monthlyRows.subjectId ${row.subjectId} không tồn tại trong subjects`,
                );
            }
        }

        const savedId = await this.dataSource.transaction(async (manager) => {
            const pyRepo = manager.getRepository(PolicyYear);

            let entity = await pyRepo.findOne({
                where: { schoolId: dto.schoolId, schoolYear: dto.schoolYear },
            });

            if (entity && entity.status === PolicyYearStatus.LOCKED) {
                throw new ConflictException(
                    'Chính sách năm đã bị khóa (LOCKED), không thể cập nhật',
                );
            }

            if (!entity) {
                entity = pyRepo.create({
                    schoolId: dto.schoolId,
                    schoolYear: dto.schoolYear,
                    status: PolicyYearStatus.DRAFT,
                });
            }

            entity.schoolName = dto.schoolName ?? school.name;
            if (dto.status) entity.status = dto.status;

            const s = dto.summary;
            if (s) {
                entity.totalStudents = s.totalStudents ?? 0;
                entity.totalRevenue = s.totalRevenue ?? 0;
                entity.totalTkd = s.totalTkd ?? 0;
                entity.totalSchoolRetain = s.totalSchoolRetain ?? 0;
                entity.totalCompanyPayment = s.totalCompanyPayment ?? 0;
                entity.totalInitialPolicy = s.totalInitialPolicy ?? 0;
                entity.totalPolicyAfterTax = s.totalPolicyAfterTax ?? 0;
                entity.totalPaid = s.totalPaid ?? 0;
                entity.totalRemaining = s.totalRemaining ?? 0;
            }

            const saved = await pyRepo.save(entity);

            // Thay thế toàn bộ con (save cả form) — xóa cũ rồi tạo mới.
            await manager
                .getRepository(PolicyYearSubject)
                .delete({ policyYearId: saved.id });
            await manager
                .getRepository(PolicyYearMonthlyRow)
                .delete({ policyYearId: saved.id });

            if (subjects.length) {
                const subjectRepo = manager.getRepository(PolicyYearSubject);
                await subjectRepo.save(
                    subjects.map((sub) =>
                        subjectRepo.create({
                            policyYearId: saved.id,
                            subjectId: sub.id,
                            code: sub.code,
                            name: sub.name,
                            tuitionPrice: sub.tuitionPrice ?? 0,
                            schoolRetainUnit: sub.schoolRetainUnit ?? 0,
                            policyTotalAmount: sub.policyTotalAmount ?? 0,
                            policyStudentBase: sub.policyStudentBase ?? 0,
                            policyMonthBase: sub.policyMonthBase ?? 0,
                            taxPercent: sub.taxPercent ?? 0,
                            companyProfitPerHS: sub.companyProfitPerHS ?? 0,
                            cashSupportAmount: sub.cashSupportAmount ?? 0,
                            equipmentSupportAmount: sub.equipmentSupportAmount ?? 0,
                        }),
                    ),
                );
            }

            if (monthlyRows.length) {
                const rowRepo = manager.getRepository(PolicyYearMonthlyRow);
                await rowRepo.save(
                    monthlyRows.map((row, i) =>
                        rowRepo.create({
                            policyYearId: saved.id,
                            rowIndex: row.rowIndex ?? i,
                            subjectId: row.subjectId,
                            month: row.month,
                            studentCount: row.studentCount ?? 0,
                            unitPrice: row.unitPrice ?? 0,
                            monthsCount: row.monthsCount ?? 0,
                            principalPolicyAmount: row.principalPolicyAmount ?? 0,
                            // raw input FE gửi — KHÔNG tự nhân theo số dòng tháng.
                            cashPolicyAmount: row.cashPolicyAmount ?? 0,
                            equipmentPolicyAmount: row.equipmentPolicyAmount ?? 0,
                            paidCashAmount: row.paidCashAmount ?? 0,
                            paidEquipmentAmount: row.paidEquipmentAmount ?? 0,
                            calculatedPolicyAmount: row.calculatedPolicyAmount ?? 0,
                            policyAfterTaxAmount: row.policyAfterTaxAmount ?? 0,
                            note: row.note,
                        }),
                    ),
                );
            }

            return saved.id;
        });

        return this.findOne(savedId);
    }

    /** Lấy theo trường + năm học (dùng cho GET /policy-years?schoolId=&schoolYear=). */
    async findForSchoolYear(schoolId: number, schoolYear: string) {
        const entity = await this.loadFull({ schoolId, schoolYear });
        return entity ? this.toResponse(entity) : null;
    }

    async findAll(filters: { schoolId?: number; schoolYear?: string }) {
        const where: Record<string, unknown> = {};
        if (filters.schoolId) where.schoolId = filters.schoolId;
        if (filters.schoolYear) where.schoolYear = filters.schoolYear;

        const rows = await this.repo.find({
            where,
            relations: ['subjects', 'monthlyRows'],
            order: { updatedAt: 'DESC' },
        });
        return rows.map((r) => this.toResponse(r));
    }

    async findOne(id: number, manager?: EntityManager) {
        const entity = await this.loadFull({ id }, manager);
        if (!entity) {
            throw new NotFoundException('Chính sách năm không tồn tại');
        }
        return this.toResponse(entity);
    }

    private loadFull(
        where: Partial<Pick<PolicyYear, 'id' | 'schoolId' | 'schoolYear'>>,
        manager?: EntityManager,
    ) {
        const repo = manager ? manager.getRepository(PolicyYear) : this.repo;
        return repo.findOne({
            where,
            relations: ['subjects', 'monthlyRows'],
        });
    }

    private toResponse(entity: PolicyYear) {
        const subjects = [...(entity.subjects ?? [])]
            .sort((a, b) => a.subjectId - b.subjectId)
            .map((s) => ({
                id: s.subjectId,
                code: s.code,
                name: s.name,
                tuitionPrice: s.tuitionPrice,
                schoolRetainUnit: s.schoolRetainUnit,
                policyTotalAmount: s.policyTotalAmount,
                policyStudentBase: s.policyStudentBase,
                policyMonthBase: s.policyMonthBase,
                taxPercent: s.taxPercent,
                companyProfitPerHS: s.companyProfitPerHS,
                cashSupportAmount: s.cashSupportAmount,
                equipmentSupportAmount: s.equipmentSupportAmount,
            }));

        const monthlyRows = [...(entity.monthlyRows ?? [])]
            .sort((a, b) => a.rowIndex - b.rowIndex || a.month.localeCompare(b.month))
            .map((r) => ({
                id: r.id,
                rowIndex: r.rowIndex,
                subjectId: r.subjectId,
                month: r.month,
                studentCount: r.studentCount,
                unitPrice: r.unitPrice,
                monthsCount: r.monthsCount,
                principalPolicyAmount: r.principalPolicyAmount,
                cashPolicyAmount: r.cashPolicyAmount,
                equipmentPolicyAmount: r.equipmentPolicyAmount,
                paidCashAmount: r.paidCashAmount,
                paidEquipmentAmount: r.paidEquipmentAmount,
                calculatedPolicyAmount: r.calculatedPolicyAmount,
                policyAfterTaxAmount: r.policyAfterTaxAmount,
                note: r.note ?? '',
            }));

        return {
            id: entity.id,
            schoolId: entity.schoolId,
            schoolName: entity.schoolName ?? null,
            schoolYear: entity.schoolYear,
            status: entity.status,
            subjects,
            monthlyRows,
            summary: {
                totalStudents: entity.totalStudents,
                totalRevenue: entity.totalRevenue,
                totalTkd: entity.totalTkd,
                totalSchoolRetain: entity.totalSchoolRetain,
                totalCompanyPayment: entity.totalCompanyPayment,
                totalInitialPolicy: entity.totalInitialPolicy,
                totalPolicyAfterTax: entity.totalPolicyAfterTax,
                totalPaid: entity.totalPaid,
                totalRemaining: entity.totalRemaining,
            },
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
        };
    }
}
