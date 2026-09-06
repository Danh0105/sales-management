import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { School } from '../school/schools.entity';
import { SchoolClass, normalizeClassName } from './entities/school-class.entity';
import { TeachingSchedule } from './entities/teaching-schedule.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import {
    CreateSchoolClassDto,
    QuerySchoolClassesDto,
    UpdateSchoolClassDto,
} from './dto/school-class.dto';
import { SubjectResolverService } from './subject-resolver.service';
import { Subject } from '../subject/subject.entity';
import { Teacher } from './entities/teacher.entity';
import { SchoolLocationService } from '../school-location/school-location.service';

const MAX_LIMIT = 200;

@Injectable()
export class SchoolClassService {
    constructor(
        @InjectRepository(SchoolClass)
        private readonly classRepo: Repository<SchoolClass>,

        @InjectRepository(School)
        private readonly schoolRepo: Repository<School>,

        @InjectRepository(TeachingSchedule)
        private readonly scheduleRepo: Repository<TeachingSchedule>,

        @InjectRepository(TeachingSession)
        private readonly sessionRepo: Repository<TeachingSession>,

        @InjectRepository(Subject)
        private readonly subjectRepo: Repository<Subject>,

        @InjectRepository(Teacher)
        private readonly teacherRepo: Repository<Teacher>,

        private readonly subjectResolver: SubjectResolverService,
        private readonly schoolLocationService: SchoolLocationService,
    ) { }

    async create(dto: CreateSchoolClassDto) {
        const name = normalizeClassName(dto.name);

        if (!name) {
            throw new BadRequestException('Tên lớp không được để trống');
        }

        const school = await this.schoolRepo.findOne({
            where: { id: dto.schoolId },
        });

        if (!school) {
            throw new BadRequestException('Trường không tồn tại');
        }

        if (dto.schoolLocationId) {
            await this.schoolLocationService.assertBelongsToSchool(
                dto.schoolLocationId,
                dto.schoolId,
            );
        }

        const schoolYear = dto.schoolYear.trim();
        const subjects = await this.resolveSubjects(dto.subjectIds ?? [], dto.schoolId, schoolYear);
        await this.assertNameAvailable(
            dto.schoolId,
            name,
            schoolYear,
            undefined,
            dto.schoolLocationId ?? null,
        );

        const entity = this.classRepo.create({
            schoolId: dto.schoolId,
            schoolLocationId: dto.schoolLocationId ?? null,
            name,
            schoolYear,
            gradeLevel: dto.gradeLevel ?? null,
            studentCount: dto.studentCount ?? 0,
            homeroomTeacher: dto.homeroomTeacher || null,
            isActive: dto.isActive ?? true,
            note: dto.note || null,
            subjects,
        });

        const saved = await this.classRepo.save(entity);
        return this.findOne(saved.id);
    }

    async findAll(query: QuerySchoolClassesDto) {
        const page = query.page ?? 1;
        const limit = Math.min(query.limit ?? 50, MAX_LIMIT);

        const qb = this.buildClassQuery();

        if (query.schoolId) {
            qb.andWhere('c.schoolId = :schoolId', { schoolId: query.schoolId });
        }
        if (query.schoolLocationId) {
            qb.andWhere('c.schoolLocationId = :schoolLocationId', {
                schoolLocationId: query.schoolLocationId,
            });
        }
        if (query.schoolYear) {
            qb.andWhere('c.schoolYear = :schoolYear', {
                schoolYear: query.schoolYear,
            });
        }
        if (query.gradeLevel) {
            qb.andWhere('c.gradeLevel = :gradeLevel', {
                gradeLevel: query.gradeLevel,
            });
        }
        if (query.isActive !== undefined) {
            qb.andWhere('c.isActive = :isActive', { isActive: query.isActive });
        }
        if (query.search) {
            qb.andWhere('(c.name ILIKE :search OR c.homeroomTeacher ILIKE :search)', {
                search: `%${query.search}%`,
            });
        }

        const total = await qb.getCount();

        const rows = await qb
            .orderBy('c.gradeLevel', 'ASC', 'NULLS LAST')
            .addOrderBy('c.name', 'ASC')
            .addOrderBy('c.id', 'ASC')
            .limit(limit)
            .offset((page - 1) * limit)
            .getRawMany();

        const data = await this.attachSubjectsAndSuggestions(
            rows.map((row) => this.toClassItem(row)),
        );

        return {
            data: query.catalogId
                ? await this.annotateSubject(data, query.catalogId, query.schoolYear)
                : data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Gắn môn tương ứng của trường vào từng lớp — màn "áp môn cho nhiều lớp"
     * cần thấy trước lớp nào dùng được, lớp nào trường chưa khai môn đó.
     */
    private async annotateSubject(
        data: ReturnType<SchoolClassService['toClassItem']>[],
        catalogId: number,
        schoolYear?: string,
    ) {
        const classes = new Map(
            data.map((item) => [
                item.id,
                {
                    id: item.id,
                    name: item.name,
                    schoolId: item.schoolId,
                    schoolName: item.schoolName,
                    schoolYear: item.schoolYear,
                },
            ]),
        );

        const matches = await this.subjectResolver.resolveSubjects(
            { catalogId, schoolYear },
            data.map((item) => ({ classId: item.id })),
            classes,
        );

        return data.map((item) => {
            const match = matches.get(item.id);

            return {
                ...item,
                subjectStatus: match?.status ?? 'MISSING',
                subjectId: match?.status === 'RESOLVED' ? match.subjectId : null,
                subjectName: match?.status === 'RESOLVED' ? match.subjectName : null,
                subjectReason: match && match.status !== 'RESOLVED' ? match.reason : null,
            };
        });
    }

    async findOne(id: number) {
        const row = await this.buildClassQuery()
            .andWhere('c.id = :id', { id })
            .getRawOne();

        if (!row) {
            throw new NotFoundException('Lớp học không tồn tại');
        }

        return (await this.attachSubjectsAndSuggestions([this.toClassItem(row)]))[0];
    }

    async update(id: number, dto: UpdateSchoolClassDto) {
        const entity = await this.getEntity(id);

        const name =
            dto.name !== undefined ? normalizeClassName(dto.name) : entity.name;

        if (!name) {
            throw new BadRequestException('Tên lớp không được để trống');
        }

        const schoolYear =
            dto.schoolYear !== undefined ? dto.schoolYear.trim() : entity.schoolYear;

        // Điểm trường đích của lần sửa này — cần biết trước để kiểm tra trùng tên
        // đúng phạm vi cơ sở.
        const nextLocationId =
            dto.schoolLocationId !== undefined
                ? (dto.schoolLocationId ?? null)
                : (entity.schoolLocationId ?? null);

        // Chỉ đổi mỗi điểm trường cũng phải kiểm tra: cơ sở đích có thể đã có
        // lớp trùng tên trong cùng năm học.
        if (
            name !== entity.name ||
            schoolYear !== entity.schoolYear ||
            nextLocationId !== (entity.schoolLocationId ?? null)
        ) {
            await this.assertNameAvailable(
                entity.schoolId,
                name,
                schoolYear,
                id,
                nextLocationId,
            );
        }

        entity.name = name;
        entity.schoolYear = schoolYear;

        if (dto.subjectIds !== undefined) {
            entity.subjects = await this.resolveSubjects(
                dto.subjectIds,
                entity.schoolId,
                schoolYear,
            );
        } else if (dto.schoolYear !== undefined) {
            const current = await this.classRepo.findOne({
                where: { id },
                relations: { subjects: true },
            });
            await this.resolveSubjects(
                (current?.subjects ?? []).map((subject) => subject.id),
                entity.schoolId,
                schoolYear,
            );
        }

        if (dto.gradeLevel !== undefined) entity.gradeLevel = dto.gradeLevel ?? null;
        if (dto.studentCount !== undefined) entity.studentCount = dto.studentCount;
        if (dto.homeroomTeacher !== undefined) {
            entity.homeroomTeacher = dto.homeroomTeacher || null;
        }
        if (dto.isActive !== undefined) entity.isActive = dto.isActive;
        if (dto.note !== undefined) entity.note = dto.note || null;

        /**
         * Chuyển lớp sang điểm trường khác (hoặc gỡ về mức trường). Khác với
         * `schoolId` bị khoá cứng, đổi điểm trường trong CÙNG một trường không
         * làm hỏng lịch đã sinh: buổi dạy đã tạo giữ nguyên `schoolLocationId`
         * chốt lúc sinh, chỉ buổi sinh MỚI mới theo điểm mới — cùng cách đơn
         * giá không hồi tố các buổi đã chốt.
         */
        if (dto.schoolLocationId !== undefined) {
            if (dto.schoolLocationId) {
                await this.schoolLocationService.assertBelongsToSchool(
                    dto.schoolLocationId,
                    entity.schoolId,
                );
            }
            entity.schoolLocationId = dto.schoolLocationId ?? null;
        }

        await this.classRepo.save(entity);
        return this.findOne(id);
    }

    /**
     * Xoá lớp. Lớp đã được xếp lịch thì không xoá được (mất luôn lịch/chấm công
     * theo FK CASCADE) — Nhân sự nên tắt `isActive` để ngừng dùng.
     */
    async remove(id: number) {
        const entity = await this.getEntity(id);

        const [scheduleCount, sessionCount] = await Promise.all([
            this.scheduleRepo.count({ where: { classId: id } }),
            this.sessionRepo.count({ where: { classId: id } }),
        ]);

        if (scheduleCount > 0 || sessionCount > 0) {
            throw new ConflictException(
                `Lớp "${entity.name}" đang có ${scheduleCount} lịch dạy và ${sessionCount} buổi dạy, ` +
                'không xoá được. Hãy đặt isActive = false để ngừng sử dụng.',
            );
        }

        await this.classRepo.remove(entity);
        return { deleted: true, id };
    }

    /**
     * Lấy lớp để xếp lịch: phải tồn tại, còn hoạt động, và (nếu FE gửi kèm
     * schoolId) phải đúng trường đó. Trả về lớp để lấy `schoolId` chuẩn.
     */
    async resolveForScheduling(
        classId: number,
        schoolId?: number | null,
    ): Promise<SchoolClass> {
        const entity = await this.classRepo.findOne({ where: { id: classId } });

        if (!entity) {
            throw new BadRequestException('Lớp học không tồn tại');
        }

        if (!entity.isActive) {
            throw new BadRequestException(`Lớp "${entity.name}" đang ngừng sử dụng`);
        }

        if (schoolId && schoolId !== entity.schoolId) {
            throw new BadRequestException('Lớp học không thuộc trường đã chọn');
        }

        return entity;
    }

    private async getEntity(id: number): Promise<SchoolClass> {
        const entity = await this.classRepo.findOne({ where: { id } });

        if (!entity) {
            throw new NotFoundException('Lớp học không tồn tại');
        }

        return entity;
    }

    private buildClassQuery() {
        return this.classRepo
            .createQueryBuilder('c')
            .innerJoin('c.school', 'sc')
            // Lớp không gắn điểm trường vẫn phải xuất hiện -> leftJoin.
            .leftJoin('c.schoolLocation', 'sl')
            .select([
                'c.id AS "id"',
                'c.schoolId AS "schoolId"',
                'sc.name AS "schoolName"',
                'c.schoolLocationId AS "schoolLocationId"',
                'sl.name AS "locationName"',
                'c.name AS "name"',
                'c.gradeLevel AS "gradeLevel"',
                'c.schoolYear AS "schoolYear"',
                'c.studentCount AS "studentCount"',
                'c.homeroomTeacher AS "homeroomTeacher"',
                'c.isActive AS "isActive"',
                'c.note AS "note"',
            ])
            .addSelect(
                `(SELECT COUNT(*) FROM teaching_schedules ts WHERE ts.class_id = c.id)`,
                'scheduleCount',
            )
            .addSelect(
                `(SELECT COUNT(*) FROM teaching_sessions tss WHERE tss.class_id = c.id)`,
                'sessionCount',
            );
    }

    private toClassItem(row: Record<string, any>) {
        return {
            id: Number(row.id),
            schoolId: Number(row.schoolId),
            schoolName: row.schoolName,
            schoolLocationId:
                row.schoolLocationId == null ? null : Number(row.schoolLocationId),
            locationName: row.locationName ?? null,
            name: row.name,
            gradeLevel: row.gradeLevel === null ? null : Number(row.gradeLevel),
            schoolYear: row.schoolYear,
            studentCount: Number(row.studentCount ?? 0),
            homeroomTeacher: row.homeroomTeacher ?? null,
            isActive: row.isActive,
            note: row.note ?? null,
            scheduleCount: Number(row.scheduleCount ?? 0),
            sessionCount: Number(row.sessionCount ?? 0),
        };
    }

    private async resolveSubjects(ids: number[], schoolId: number, schoolYear: string) {
        if (!ids.length) return [];

        const subjects = await this.subjectRepo.find({ where: { id: In(ids) } });
        if (subjects.length !== ids.length) {
            const found = new Set(subjects.map((subject) => subject.id));
            throw new BadRequestException(
                `Môn học không tồn tại: ${ids.filter((id) => !found.has(id)).join(', ')}`,
            );
        }

        const invalidSchool = subjects.find((subject) => subject.schoolId !== schoolId);
        if (invalidSchool) {
            throw new BadRequestException(`Môn "${invalidSchool.name}" không thuộc trường đã chọn`);
        }

        const invalidYear = subjects.find(
            (subject) => subject.schoolYear && subject.schoolYear !== schoolYear,
        );
        if (invalidYear) {
            throw new BadRequestException(
                `Môn "${invalidYear.name}" thuộc năm học ${invalidYear.schoolYear}, không phải ${schoolYear}`,
            );
        }

        return ids.map((id) => subjects.find((subject) => subject.id === id)!);
    }

    /** Đính kèm môn và gợi ý giáo viên có đúng năng lực môn + được dạy tại trường. */
    private async attachSubjectsAndSuggestions<T extends { id: number; schoolId: number }>(
        classes: T[],
    ) {
        if (!classes.length) return [];

        const entities = await this.classRepo.find({
            where: { id: In(classes.map((item) => item.id)) },
            relations: { subjects: true },
        });
        const teachers = await this.teacherRepo.find({
            where: { isActive: true },
            relations: ['allowedWards', 'allowedWards.schools', 'teachableSubjectCatalogs'],
        });
        const byId = new Map(entities.map((entity) => [entity.id, entity]));

        return classes.map((item) => {
            const subjects = byId.get(item.id)?.subjects ?? [];
            return {
                ...item,
                subjectIds: subjects.map((subject) => subject.id),
                subjects: subjects.map((subject) => ({
                    id: subject.id,
                    name: subject.name,
                    code: subject.code ?? null,
                    catalogId: subject.catalogId ?? null,
                    recommendedTeachers: subject.catalogId
                        ? teachers
                            .filter(
                                (teacher) =>
                                    (teacher.allowedWards ?? []).some((ward) =>
                                        (ward.schools ?? []).some((school) => school.id === item.schoolId),
                                    ) &&
                                    teacher.teachableSubjectCatalogs?.some(
                                        (catalog) => catalog.id === subject.catalogId,
                                    ),
                            )
                            .map((teacher) => ({ id: teacher.id, name: teacher.name }))
                        : [],
                })),
            };
        });
    }

    /** Trong một trường + một năm học, tên lớp không trùng (không phân biệt hoa/thường). */
    /**
     * Trùng tên lớp được xét trong phạm vi MỘT điểm trường, không phải cả trường:
     * hai cơ sở của cùng một trường đều có lớp "1A" là chuyện bình thường. Dùng
     * COALESCE để lớp chưa gắn điểm trường (NULL) vẫn so được với nhau — khớp
     * đúng unique index `(school_id, COALESCE(school_location_id,0), name, school_year)`.
     */
    private async assertNameAvailable(
        schoolId: number,
        name: string,
        schoolYear: string,
        exceptId?: number,
        schoolLocationId?: number | null,
    ) {
        const qb = this.classRepo
            .createQueryBuilder('c')
            .where('c.schoolId = :schoolId', { schoolId })
            .andWhere('LOWER(c.name) = LOWER(:name)', { name })
            .andWhere('c.schoolYear = :schoolYear', { schoolYear })
            .andWhere(
                'COALESCE(c.schoolLocationId, 0) = COALESCE(:schoolLocationId, 0)',
                { schoolLocationId: schoolLocationId ?? null },
            );

        if (exceptId) {
            qb.andWhere('c.id != :exceptId', { exceptId });
        }

        const existed = await qb.getOne();

        if (existed) {
            throw new ConflictException(
                schoolLocationId
                    ? `Lớp "${existed.name}" năm học ${schoolYear} đã tồn tại ở điểm trường này`
                    : `Lớp "${existed.name}" năm học ${schoolYear} đã tồn tại ở trường này`,
            );
        }
    }
}
