import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Subject } from './subject.entity';
import { School } from '../school/schools.entity';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { PolicyStatus } from '../policy/policy.enum';
import { ExpenseItem } from '../expense-item/expense-item.entity';
import { CashPolicyItem } from '../cash-policy-item/cash-policy-item.entity';
import { SubjectCatalogsService } from '../subject-catalog/subject-catalog.service';
import { SchoolLocationService } from '../school-location/school-location.service';

@Injectable()
export class SubjectsService {
    constructor(
        @InjectRepository(Subject)
        private subjectRepo: Repository<Subject>,

        @InjectRepository(School)
        private schoolRepo: Repository<School>,

        @InjectRepository(SchoolExpense)
        private readonly schoolExpenseRepo: Repository<SchoolExpense>,

        @InjectRepository(CashPolicyItem)
        private readonly cashPolicyItemRepo: Repository<CashPolicyItem>,

        @InjectRepository(ExpenseItem)
        private readonly expenseItemRepo: Repository<ExpenseItem>,

        private readonly catalogService: SubjectCatalogsService,
        private readonly schoolLocationService: SchoolLocationService,
    ) { }

    async create(dto: CreateSubjectDto) {
        const school = await this.schoolRepo.findOne({
            where: { id: dto.schoolId },
        });

        if (!school) {
            throw new NotFoundException('School not found');
        }

        if (dto.schoolLocationId) {
            await this.schoolLocationService.assertBelongsToSchool(
                dto.schoolLocationId,
                dto.schoolId,
            );
        }

        // Môn học phải chọn từ danh mục do sales admin tạo (không nhập tự do nữa).
        const catalog = await this.catalogService.resolveForSubject(
            { catalogId: dto.catalogId, name: dto.name },
            { requireActive: true },
        );

        const subject = this.subjectRepo.create({
            name: catalog.name,
            catalogId: catalog.id,
            school,
            schoolLocationId: dto.schoolLocationId ?? null,
            status: dto.status ?? 0,
            studentCount: dto.studentCount ?? 0,
            classCount: dto.classCount ?? 0,
            totalLessons: dto.totalLessons ?? 0,
            contractDuration: dto.contractDuration ?? 0,
            appendixDuration: dto.appendixDuration ?? 0,
            startDate: dto.startDate ? new Date(dto.startDate) : null,
            schoolYear: dto.schoolYear,
            ratePerPeriod: dto.ratePerPeriod ?? null,
        } as Partial<Subject>);

        const saved = await this.subjectRepo.save(subject);

        const code = `SUB${String(saved.id).padStart(3, '0')}`;
        const shortName = catalog.name
            .trim()
            .split(/\s+/)
            .map(word => word[0])
            .join('')
            .toUpperCase();

        const match = dto.schoolYear?.match(/\d{4}/);
        const year = match ? Number(match[0]) : new Date().getFullYear();

        const contractNumber = `${shortName}${String(saved.id).padStart(2, '0')}|${year}`;

        await this.subjectRepo.update(saved.id, {
            code,
            contractNumber,
        });

        return {
            ...saved,
            code,
            contractNumber,
        };
    }
    findAll() {
        // Kèm số chính sách của từng môn: FE cần con số này để cảnh báo trước khi
        // xoá môn (xoá môn là cascade xoá luôn chính sách của môn đó).
        return this.subjectRepo
            .createQueryBuilder('subject')
            .leftJoinAndSelect('subject.school', 'school')
            .leftJoinAndSelect('subject.catalog', 'catalog')
            .loadRelationCountAndMap(
                'subject.policyCount',
                'subject.policies',
            )
            .orderBy('subject.id', 'DESC')
            .getMany();
    }

    async findBySchool(schoolId: number, schoolYear?: string) {
        const qb = this.subjectRepo
            .createQueryBuilder('subject')
            .leftJoinAndSelect('subject.catalog', 'catalog')
            .where('subject.school_id = :schoolId', { schoolId });

        if (schoolYear) {
            qb.andWhere('subject.school_year = :schoolYear', { schoolYear });
        }

        return qb
            .loadRelationCountAndMap(
                'subject.policyCount',
                'subject.policies'
            )
            .orderBy('subject.id', 'DESC')
            .getMany();
    }

    async findFinanceBySchool(
        schoolId: number,
        schoolYear?: string,
    ) {
        const subjects = await this.subjectRepo
            .createQueryBuilder('subject')

            .leftJoinAndSelect(
                'subject.school',
                'school',
            )

            .leftJoinAndSelect(
                'subject.catalog',
                'catalog',
            )

            .leftJoinAndSelect(
                'subject.policies',
                'policy',
                'policy.status = :status',
                {
                    status:
                        PolicyStatus.DIRECTOR_APPROVED,
                },
            )

            .where(
                'subject.school_id = :schoolId',
                {
                    schoolId,
                },
            )

            .andWhere(
                schoolYear
                    ? 'subject.school_year = :schoolYear'
                    : '1=1',
                { schoolYear },
            )

            .orderBy('subject.id', 'DESC')

            .getMany();

        const subjectIds = subjects.map(
            (s) => s.id,
        );

        // KHÔNG CÓ SUBJECT
        if (subjectIds.length === 0) {
            return [];
        }

        const expenseItems =
            await this.expenseItemRepo
                .createQueryBuilder(
                    'expenseItem',
                )

                .leftJoinAndSelect(
                    'expenseItem.schoolExpense',
                    'schoolExpense',
                )

                .leftJoinAndSelect(
                    'schoolExpense.period',
                    'period',
                )

                .leftJoinAndSelect(
                    'expenseItem.subject',
                    'subject',
                )

                .where(
                    'expenseItem.subject_id IN (:...subjectIds)',
                    { subjectIds },
                )

                .getMany();

        const schoolExpenseIds = [
            ...new Set(
                expenseItems
                    .map(
                        (x) =>
                            x.schoolExpense?.id,
                    )
                    .filter(Boolean),
            ),
        ];

        let cashPolicyItems: CashPolicyItem[] = [];
        // CHỈ QUERY KHI CÓ IDS
        if (schoolExpenseIds.length > 0) {
            cashPolicyItems =
                await this.cashPolicyItemRepo
                    .createQueryBuilder(
                        'cashPolicyItem',
                    )

                    .leftJoinAndSelect(
                        'cashPolicyItem.schoolExpense',
                        'schoolExpense',
                    )

                    .where(
                        'schoolExpense.id IN (:...ids)',
                        {
                            ids: schoolExpenseIds,
                        },
                    )

                    .getMany();
        }

        return subjects.map((subject) => {
            const items = expenseItems.filter(
                (x) =>
                    x.subject?.id ===
                    subject.id,
            );

            const cashPolicies =
                cashPolicyItems.filter((x) =>
                    items.some(
                        (i) =>
                            i.schoolExpense
                                ?.id ===
                            x.schoolExpense?.id,
                    ),
                );

            return {
                ...subject,
                expenseItems: items,
                cashPolicyItems: cashPolicies,
            };
        });
    }
    async findOne(id: number) {
        const subject = await this.subjectRepo.findOne({
            where: { id },
            relations: ['school', 'catalog'],
        });

        if (!subject) throw new NotFoundException('Subject not found');
        return subject;
    }

    async update(id: number, dto: UpdateSubjectDto) {
        const subject = await this.findOne(id);

        const { schoolId, startDate, contractDuration, catalogId, name, ...rest } =
            dto;

        Object.assign(subject, {
            ...rest,
            contractDuration,
            startDate: startDate ? new Date(startDate) : subject.startDate,
        });

        // Đổi môn học: chỉ nhận môn có trong danh mục. Không gửi gì thì giữ nguyên
        // môn cũ (kể cả môn cũ nhập tay chưa map được vào danh mục).
        if (catalogId !== undefined || name !== undefined) {
            const catalog = await this.catalogService.resolveForSubject(
                { catalogId, name },
                { requireActive: true },
            );

            subject.catalogId = catalog.id;
            subject.catalog = catalog;
            subject.name = catalog.name;
        }

        if (schoolId !== undefined) {
            subject.school = { id: schoolId } as School;
        }

        return this.subjectRepo.save(subject);
    }

    /**
     * Xoá môn học — **chặn khi còn lịch dạy tham chiếu**.
     *
     * FK `teaching_schedules.subject_id` / `teaching_sessions.subject_id` là
     * ON DELETE CASCADE: xoá môn là xoá sạch mẫu lịch và mọi buổi dạy (kể cả
     * đã check-in, đã báo giảng) mà không có gì cản. Ngày 14/09/2026 một nhân
     * viên kinh doanh xoá 2 môn của THCS Quang Trung để "làm lại" chính sách
     * năm mới và kéo theo toàn bộ TKB + công của 2 giáo viên. Xoá mẫu lịch
     * đã có chốt "đã chấm công thì không xoá" — xoá môn không được đi vòng
     * qua chốt đó.
     */
    async remove(id: number) {
        const subject = await this.findOne(id);

        const [{ schedules, sessions }] = await this.subjectRepo.manager.query(
            `SELECT
               (SELECT count(*) FROM teaching_schedules WHERE subject_id = $1)::int AS schedules,
               (SELECT count(*) FROM teaching_sessions  WHERE subject_id = $1)::int AS sessions`,
            [id],
        );

        if (schedules > 0 || sessions > 0) {
            throw new ConflictException(
                `Môn "${subject.name}" đang có ${schedules} mẫu lịch dạy và ${sessions} buổi dạy. ` +
                    'Xoá môn sẽ xoá theo toàn bộ lịch và công của giáo viên — ' +
                    'hãy xoá/chuyển lịch dạy sang môn khác trước, hoặc dùng chức năng gộp môn.',
            );
        }

        return this.subjectRepo.remove(subject);
    }

    /**
     * Áp cùng một đơn giá cho nhiều môn học (mỗi phần tử là môn của một
     * trường) trong một lần — VD nhiều trường cùng dạy Toán và Nhân sự vừa
     * thoả cùng một mức giá, khỏi phải sửa từng trường một.
     */
    async bulkUpdateRate(subjectIds: number[], ratePerPeriod: number) {
        const ids = Array.from(new Set(subjectIds));
        const result = await this.subjectRepo.update(
            { id: In(ids) },
            { ratePerPeriod },
        );

        if (!result.affected) {
            throw new NotFoundException('Không tìm thấy môn học nào để cập nhật');
        }

        return this.subjectRepo.find({
            where: { id: In(ids) },
            relations: ['school', 'catalog'],
            order: { schoolId: 'ASC' },
        });
    }

    async findBySchoolYearAndSchool(
        schoolYear: string,
        schoolId: number,
    ) {
        return this.subjectRepo
            .createQueryBuilder('subject')
            .leftJoinAndSelect('subject.school', 'school')
            .leftJoinAndSelect('subject.catalog', 'catalog')
            .where('subject.school_year = :schoolYear', { schoolYear })
            .andWhere('subject.school_id = :schoolId', { schoolId })
            .loadRelationCountAndMap(
                'subject.policyCount',
                'subject.policies'
            )
            .orderBy('subject.id', 'DESC')
            .getMany();
    }
    async getSchoolsBySubject(
        schoolYear?: string,
        subjectName?: string,
        catalogId?: number,
    ) {
        const qb = this.schoolRepo
            .createQueryBuilder('school')
            .leftJoinAndSelect('school.subjects', 'subject')
            .leftJoinAndSelect('subject.catalog', 'catalog');

        if (schoolYear) {
            qb.andWhere('subject.school_year = :schoolYear', { schoolYear });
        }

        if (catalogId) {
            qb.andWhere('subject.catalog_id = :catalogId', { catalogId });
        }

        if (subjectName) {
            qb.andWhere('subject.name ILIKE :name', {
                name: `%${subjectName}%`,
            });
        }

        return qb
            .orderBy('school.id', 'DESC')
            .getMany();
    }
}