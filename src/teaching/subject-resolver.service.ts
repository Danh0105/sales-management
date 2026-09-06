import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SchoolClass } from './entities/school-class.entity';
import { Subject } from '../subject/subject.entity';
import { SubjectCatalog } from '../subject-catalog/subject-catalog.entity';

/** Kết quả tra môn của trường cho một lớp. */
export type SubjectMatch =
    | { status: 'RESOLVED'; subjectId: number; subjectName: string }
    | { status: 'MISSING'; reason: string }
    | { status: 'AMBIGUOUS'; reason: string };

/** Lớp kèm tên trường — đủ để báo kết quả cho từng dòng. */
export interface ClassInfo {
    id: number;
    name: string;
    schoolId: number;
    schoolName: string;
    schoolYear: string;
}

/**
 * Tra môn học của **từng trường** từ một môn trong **danh mục dùng chung**.
 *
 * Môn của trường (`subjects`) là bản ghi riêng cho từng trường kèm hợp đồng /
 * số tiết / năm học nên không dùng chung được giữa các trường. Nhân sự chỉ chọn
 * môn trong danh mục (`subject_catalogs`) một lần, service này map ra môn tương
 * ứng của từng trường theo năm học của lớp.
 *
 * Tách riêng khỏi TeachingBulkService vì SchoolClassService cũng dùng (để
 * annotate danh sách lớp), mà SchoolClassService lại là dependency của
 * TeachingScheduleService — để chung sẽ thành phụ thuộc vòng.
 */
@Injectable()
export class SubjectResolverService {
    constructor(
        @InjectRepository(SchoolClass)
        private readonly classRepo: Repository<SchoolClass>,

        @InjectRepository(Subject)
        private readonly subjectRepo: Repository<Subject>,

        @InjectRepository(SubjectCatalog)
        private readonly catalogRepo: Repository<SubjectCatalog>,
    ) { }

    /**
     * Tra môn của từng trường cho từng lớp.
     *
     * Ưu tiên `subjectId` khai thẳng ở dòng đó; còn lại tra theo
     * (trường của lớp, `catalogId`, năm học) — năm học lấy theo lớp trừ khi lô
     * chỉ định khác.
     */
    async resolveSubjects(
        dto: { catalogId?: number; schoolYear?: string },
        items: Array<{ classId: number; subjectId?: number }>,
        classes: Map<number, ClassInfo>,
    ): Promise<Map<number, SubjectMatch>> {
        const result = new Map<number, SubjectMatch>();

        const explicitIds = [
            ...new Set(
                items.map((i) => i.subjectId).filter((id): id is number => !!id),
            ),
        ];

        const explicit = explicitIds.length
            ? await this.subjectRepo.find({ where: { id: In(explicitIds) } })
            : [];
        const explicitById = new Map(explicit.map((s) => [s.id, s]));

        const needsCatalog = items.filter((i) => !i.subjectId);

        if (needsCatalog.length > 0 && !dto.catalogId) {
            throw new BadRequestException(
                'Vui lòng chọn môn học trong danh mục (catalogId) hoặc khai subjectId cho từng lớp',
            );
        }

        let catalogName = '';
        const bySchoolYear = new Map<string, Subject[]>();

        if (dto.catalogId && needsCatalog.length > 0) {
            const catalog = await this.catalogRepo.findOne({
                where: { id: dto.catalogId },
            });

            if (!catalog) {
                throw new BadRequestException('Môn học không có trong danh mục');
            }

            catalogName = catalog.name;

            const schoolIds = [
                ...new Set(
                    needsCatalog
                        .map((i) => classes.get(i.classId)?.schoolId)
                        .filter((id): id is number => !!id),
                ),
            ];

            const candidates = schoolIds.length
                ? await this.subjectRepo.find({
                    where: { catalogId: dto.catalogId, schoolId: In(schoolIds) },
                })
                : [];

            candidates.forEach((subject) => {
                const key = `${subject.schoolId}|${subject.schoolYear ?? ''}`;
                bySchoolYear.set(key, [...(bySchoolYear.get(key) ?? []), subject]);
            });
        }

        for (const item of items) {
            const info = classes.get(item.classId);

            if (item.subjectId) {
                const subject = explicitById.get(item.subjectId);

                if (!subject) {
                    result.set(item.classId, {
                        status: 'MISSING',
                        reason: 'Môn học không tồn tại',
                    });
                } else {
                    result.set(item.classId, {
                        status: 'RESOLVED',
                        subjectId: subject.id,
                        subjectName: subject.name,
                    });
                }
                continue;
            }

            if (!info) {
                result.set(item.classId, {
                    status: 'MISSING',
                    reason: 'Lớp học không tồn tại',
                });
                continue;
            }

            const schoolYear = dto.schoolYear ?? info.schoolYear;
            const matches = bySchoolYear.get(`${info.schoolId}|${schoolYear}`) ?? [];

            if (matches.length === 0) {
                result.set(item.classId, {
                    status: 'MISSING',
                    reason:
                        `Trường "${info.schoolName}" chưa khai môn "${catalogName}" ` +
                        `cho năm học ${schoolYear}`,
                });
                continue;
            }

            if (matches.length > 1) {
                result.set(item.classId, {
                    status: 'AMBIGUOUS',
                    reason:
                        `Trường "${info.schoolName}" có ${matches.length} môn "${catalogName}" ` +
                        `năm học ${schoolYear}, hãy khai subjectId cho lớp này`,
                });
                continue;
            }

            result.set(item.classId, {
                status: 'RESOLVED',
                subjectId: matches[0].id,
                subjectName: matches[0].name,
            });
        }

        return result;
    }

    async loadClasses(classIds: number[]): Promise<Map<number, ClassInfo>> {
        if (classIds.length === 0) return new Map();

        const rows = await this.classRepo
            .createQueryBuilder('c')
            .innerJoin('c.school', 'sc')
            .select([
                'c.id AS "id"',
                'c.name AS "name"',
                'c.schoolId AS "schoolId"',
                'sc.name AS "schoolName"',
                'c.schoolYear AS "schoolYear"',
            ])
            .where('c.id IN (:...classIds)', { classIds })
            .getRawMany();

        return new Map(
            rows.map((row) => [
                Number(row.id),
                {
                    id: Number(row.id),
                    name: row.name,
                    schoolId: Number(row.schoolId),
                    schoolName: row.schoolName,
                    schoolYear: row.schoolYear,
                },
            ]),
        );
    }
}
