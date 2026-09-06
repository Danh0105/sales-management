import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { Policy } from '../policy/entities/policy.entity';
import { PolicyStatus } from '../policy/policy.enum';
import { Subject } from './subject.entity';

/** Một môn của năm cũ và những gì sẽ được tạo cho năm mới. */
export interface RolloverItem {
    fromSubjectId: number;
    name: string;
    catalogId: number | null;
    /** Số chính sách đã duyệt của năm cũ sẽ được sao chép. */
    approvedPolicies: number;
    /** null khi chưa tạo (dry-run) hoặc bị bỏ qua. */
    toSubjectId: number | null;
    status: 'COPIED' | 'SKIPPED';
    reason?: string;
}

export interface RolloverResult {
    dryRun: boolean;
    schoolId: number;
    schoolName: string;
    fromYear: string;
    toYear: string;
    subjectsCopied: number;
    subjectsSkipped: number;
    policiesCopied: number;
    items: RolloverItem[];
}

/**
 * Áp chính sách của năm học trước sang năm học sau.
 *
 * Chính sách gắn với **môn của một năm cụ thể** (`policy.subjectId` →
 * `subjects.school_year`), nên không thể "dùng lại" chính sách cũ cho năm mới:
 * bắt buộc phải có bản ghi môn của năm mới rồi mới có chỗ gắn chính sách. Vì
 * vậy một lần chạy làm hai việc — tạo môn năm mới theo thông tin năm cũ, rồi
 * sao chép chính sách sang.
 *
 * Chỉ chép chính sách **đã được giám đốc duyệt**; bản nháp và bản bị từ chối
 * của năm cũ không mang sang. Bản sao về trạng thái `DRAFT` — số liệu được giữ
 * nguyên để khỏi nhập lại, nhưng vẫn phải đi qua đúng quy trình duyệt của năm
 * mới, không có chuyện giá năm ngoái tự động thành giá năm nay.
 */
@Injectable()
export class SchoolYearRolloverService {
    private readonly logger = new Logger(SchoolYearRolloverService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    async rollover(input: {
        schoolId: number;
        fromYear: string;
        toYear: string;
        dryRun?: boolean;
        /** Chỉ áp các môn này (id môn của năm nguồn). Bỏ trống = áp tất cả. */
        subjectIds?: number[];
        /**
         * Có giá trị = chỉ được áp cho trường do nhân viên này phụ trách
         * (`schools.employee_id`). Controller suy ra từ token cho role `sales`.
         */
        restrictToEmployeeId?: number;
    }): Promise<RolloverResult> {
        const fromYear = input.fromYear.trim();
        const toYear = input.toYear.trim();

        if (!fromYear || !toYear) {
            throw new BadRequestException('Thiếu năm học nguồn hoặc năm học đích');
        }
        if (fromYear === toYear) {
            throw new BadRequestException(
                'Năm học nguồn và năm học đích phải khác nhau',
            );
        }

        return this.dataSource.transaction(async (manager) => {
            const [school] = await manager.query(
                `SELECT id, name, employee_id FROM schools WHERE id = $1`,
                [input.schoolId],
            );
            if (!school) throw new BadRequestException('Trường không tồn tại');

            if (
                input.restrictToEmployeeId != null &&
                Number(school.employee_id) !== Number(input.restrictToEmployeeId)
            ) {
                throw new ForbiddenException(
                    'Bạn chỉ được áp chính sách cho trường mình phụ trách',
                );
            }

            const yearSubjects = await manager.find(Subject, {
                where: { schoolId: input.schoolId, schoolYear: fromYear },
                order: { id: 'ASC' },
            });

            if (yearSubjects.length === 0) {
                throw new BadRequestException(
                    `Trường chưa có môn học nào trong năm ${fromYear}`,
                );
            }

            // Lọc theo môn được chọn. Id lạ (môn của năm khác / trường khác) bị
            // bỏ qua ở đây, nên không thể dùng tham số này để chép chéo dữ liệu.
            const picked = input.subjectIds?.length
                ? new Set(input.subjectIds.map(Number))
                : null;
            const fromSubjects = picked
                ? yearSubjects.filter((subject) => picked.has(subject.id))
                : yearSubjects;

            if (fromSubjects.length === 0) {
                throw new BadRequestException(
                    `Không có môn nào được chọn thuộc năm ${fromYear} của trường này`,
                );
            }

            // Môn đã có ở năm đích thì bỏ qua — chạy lại lần hai không nhân đôi.
            const existing = await manager.find(Subject, {
                where: { schoolId: input.schoolId, schoolYear: toYear },
            });
            const existingKeys = new Set(
                existing.map((s) => this.subjectKey(s)),
            );

            const items: RolloverItem[] = [];
            let policiesCopied = 0;

            for (const from of fromSubjects) {
                const approved = await manager.find(Policy, {
                    where: {
                        subjectId: from.id,
                        status: PolicyStatus.DIRECTOR_APPROVED,
                    },
                });

                if (existingKeys.has(this.subjectKey(from))) {
                    items.push({
                        fromSubjectId: from.id,
                        name: from.name,
                        catalogId: from.catalogId ?? null,
                        approvedPolicies: approved.length,
                        toSubjectId: null,
                        status: 'SKIPPED',
                        reason: `Năm ${toYear} đã có môn này`,
                    });
                    continue;
                }

                if (input.dryRun) {
                    items.push({
                        fromSubjectId: from.id,
                        name: from.name,
                        catalogId: from.catalogId ?? null,
                        approvedPolicies: approved.length,
                        toSubjectId: null,
                        status: 'COPIED',
                    });
                    policiesCopied += approved.length;
                    continue;
                }

                const created = await this.copySubject(manager, from, toYear);

                for (const policy of approved) {
                    await manager.save(
                        manager.create(Policy, {
                            subjectId: created.id,
                            data: policy.data,
                            durationMonths: policy.durationMonths,
                            note: policy.note,
                            // Bản sao phải đi lại quy trình duyệt của năm mới.
                            status: PolicyStatus.DRAFT,
                            // `currentHistoryId` trỏ vào lịch sử của chính sách
                            // cũ — mang sang là gắn nhầm vết của năm khác.
                            currentHistoryId: undefined,
                        }),
                    );
                    policiesCopied += 1;
                }

                items.push({
                    fromSubjectId: from.id,
                    name: from.name,
                    catalogId: from.catalogId ?? null,
                    approvedPolicies: approved.length,
                    toSubjectId: created.id,
                    status: 'COPIED',
                });
            }

            const copied = items.filter((i) => i.status === 'COPIED').length;

            if (!input.dryRun) {
                this.logger.log(
                    `Áp chính sách ${fromYear} -> ${toYear} cho trường ${input.schoolId}: ` +
                        `${copied} môn, ${policiesCopied} chính sách`,
                );
            }

            return {
                dryRun: Boolean(input.dryRun),
                schoolId: input.schoolId,
                schoolName: school.name,
                fromYear,
                toYear,
                subjectsCopied: copied,
                subjectsSkipped: items.length - copied,
                policiesCopied,
                items,
            };
        });
    }

    /**
     * Khoá nhận diện "cùng một môn" giữa hai năm: ưu tiên `catalogId` vì đó là
     * danh mục dùng chung; môn cũ chưa gắn danh mục thì lùi về tên đã chuẩn hoá.
     */
    private subjectKey(subject: Subject): string {
        return subject.catalogId != null
            ? `cat:${subject.catalogId}`
            : `name:${(subject.name ?? '').trim().toLowerCase()}`;
    }

    private async copySubject(
        manager: EntityManager,
        from: Subject,
        toYear: string,
    ): Promise<Subject> {
        const saved = await manager.save(
            manager.create(Subject, {
                name: from.name,
                catalogId: from.catalogId,
                schoolId: from.schoolId,
                studentCount: from.studentCount,
                classCount: from.classCount,
                totalLessons: from.totalLessons,
                contractDuration: from.contractDuration,
                appendixDuration: from.appendixDuration,
                startDate: this.shiftOneYear(from.startDate),
                schoolYear: toYear,
            } as Partial<Subject>),
        );

        // `code` và `contractNumber` suy ra từ id nên chỉ đặt được sau khi lưu —
        // cùng công thức với `SubjectsService.create` để hai đường tạo môn không
        // sinh ra hai kiểu mã khác nhau.
        const code = `SUB${String(saved.id).padStart(3, '0')}`;
        const shortName = (from.name ?? '')
            .trim()
            .split(/\s+/)
            .map((word) => word[0])
            .join('')
            .toUpperCase();
        const year = toYear.match(/\d{4}/)?.[0] ?? String(new Date().getFullYear());
        const contractNumber = `${shortName}${String(saved.id).padStart(2, '0')}|${year}`;

        await manager.update(Subject, saved.id, { code, contractNumber });

        return { ...saved, code, contractNumber } as Subject;
    }

    /** 2025-09-16 -> 2026-09-16. Giữ ngày/tháng khai giảng, chỉ đổi năm. */
    private shiftOneYear(date: Date | null | undefined): Date | null {
        if (!date) return null;
        const source = new Date(date);
        if (Number.isNaN(source.getTime())) return null;
        const shifted = new Date(source);
        shifted.setFullYear(source.getFullYear() + 1);
        return shifted;
    }
}
