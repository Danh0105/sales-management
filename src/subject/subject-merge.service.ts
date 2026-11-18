import {
    BadRequestException,
    Injectable,
    InternalServerErrorException,
    Logger,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

/** Một bảng đang trỏ tới `subjects.id`. */
export interface SubjectReference {
    table: string;
    column: string;
    /** `CASCADE` nghĩa là xoá môn sẽ xoá luôn dữ liệu ở bảng này. */
    deleteRule: string;
}

export interface DuplicateGroup {
    schoolId: number;
    schoolName: string;
    schoolYear: string | null;
    /** Tên đã chuẩn hoá dùng để gom nhóm. */
    normalizedName: string;
    subjects: {
        id: number;
        name: string;
        studentCount: number;
        totalLessons: number;
        contractNumber: string | null;
        catalogId: number | null;
        references: Record<string, number>;
        totalReferences: number;
    }[];
    /**
     * Mọi bản ghi trong nhóm giống nhau ở các field nghiệp vụ. Chỉ nhóm như vậy
     * mới an toàn để gộp tự động — khác số học sinh nghĩa là hai bản ghi mang
     * dữ liệu khác nhau, gộp là mất số liệu.
     */
    identical: boolean;
}

export interface MergeResult {
    dryRun: boolean;
    keepId: number;
    mergedIds: number[];
    /** Số dòng đã (hoặc sẽ) chuyển sang môn giữ lại, theo từng bảng. */
    moved: Record<string, number>;
    deletedSubjects: number;
}

/**
 * Gộp các môn học trùng nhau của cùng một trường.
 *
 * Vì sao cần API riêng thay vì xoá tay trong database: `policy`,
 * `teaching_schedules` và `teaching_sessions` đều đặt `ON DELETE CASCADE` trên
 * `subject_id`. Xoá thẳng bản ghi môn trùng sẽ **âm thầm xoá luôn** chính sách
 * và toàn bộ lịch/buổi dạy gắn với nó. Ở đây tham chiếu được chuyển sang môn
 * giữ lại **trước**, rồi mới xoá — và tất cả nằm trong một transaction.
 */
@Injectable()
export class SubjectMergeService {
    private readonly logger = new Logger(SubjectMergeService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Các bảng đang trỏ tới `subjects.id`, đọc từ chính metadata của database.
     *
     * Cố ý không hard-code danh sách: thêm một khoá ngoại mới mà quên cập nhật
     * danh sách thì lần gộp sau sẽ xoá mất dữ liệu của bảng đó. Hỏi database là
     * cách duy nhất luôn đúng.
     *
     * Đọc `pg_constraint` chứ không phải `information_schema`: view
     * `constraint_column_usage` chỉ hiện cột của bảng mà role hiện tại **sở
     * hữu**. App chạy bằng `sales_app`, bảng thuộc `sales_owner`, nên
     * `information_schema` trả rỗng — gộp sẽ xoá môn khi chưa chuyển gì, và
     * CASCADE mất luôn chính sách / lịch / buổi dạy.
     */
    async referencingTables(manager?: EntityManager): Promise<SubjectReference[]> {
        const runner = manager ?? this.dataSource.manager;
        const rows = await runner.query(`
            SELECT t.relname AS "table",
                   a.attname AS "column",
                   CASE c.confdeltype
                        WHEN 'c' THEN 'CASCADE'
                        WHEN 'n' THEN 'SET NULL'
                        WHEN 'd' THEN 'SET DEFAULT'
                        WHEN 'r' THEN 'RESTRICT'
                        ELSE 'NO ACTION'
                   END AS "deleteRule"
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f'
              AND c.confrelid = 'subjects'::regclass
            ORDER BY 1
        `);
        if (rows.length === 0) {
            throw new InternalServerErrorException(
                'Không đọc được các bảng tham chiếu tới môn học — dừng gộp để tránh mất dữ liệu',
            );
        }
        return rows as SubjectReference[];
    }

    /** Nhóm môn trùng tên trong cùng một trường và cùng năm học. */
    async findDuplicates(schoolId?: number): Promise<DuplicateGroup[]> {
        const refs = await this.referencingTables();

        const rows = await this.dataSource.query(
            `
            SELECT s.id, s.name, s.school_id AS "schoolId", sc.name AS "schoolName",
                   s.school_year AS "schoolYear", s.student_count AS "studentCount",
                   s.total_lessons AS "totalLessons",
                   s.contract_number AS "contractNumber", s.catalog_id AS "catalogId",
                   lower(btrim(s.name)) AS "normalizedName"
            FROM subjects s
            JOIN schools sc ON sc.id = s.school_id
            WHERE ($1::int IS NULL OR s.school_id = $1)
              AND (s.school_id, s.school_year, lower(btrim(s.name))) IN (
                    SELECT school_id, school_year, lower(btrim(name))
                    FROM subjects
                    GROUP BY 1, 2, 3
                    HAVING COUNT(*) > 1
                  )
            ORDER BY s.school_id, s.school_year, "normalizedName", s.id
        `,
            [schoolId ?? null],
        );

        const groups = new Map<string, DuplicateGroup>();

        for (const row of rows) {
            const key = `${row.schoolId}|${row.schoolYear}|${row.normalizedName}`;
            if (!groups.has(key)) {
                groups.set(key, {
                    schoolId: Number(row.schoolId),
                    schoolName: row.schoolName,
                    schoolYear: row.schoolYear,
                    normalizedName: row.normalizedName,
                    subjects: [],
                    identical: false,
                });
            }

            const references = await this.countReferences(refs, [Number(row.id)]);
            groups.get(key)!.subjects.push({
                id: Number(row.id),
                name: row.name,
                studentCount: Number(row.studentCount),
                totalLessons: Number(row.totalLessons),
                contractNumber: row.contractNumber,
                catalogId: row.catalogId === null ? null : Number(row.catalogId),
                references,
                totalReferences: Object.values(references).reduce((a, b) => a + b, 0),
            });
        }

        // `contractNumber` sinh từ id nên luôn khác nhau — không tính vào so sánh.
        for (const group of groups.values()) {
            const [first, ...rest] = group.subjects;
            group.identical = rest.every(
                (s) =>
                    s.studentCount === first.studentCount &&
                    s.totalLessons === first.totalLessons &&
                    s.catalogId === first.catalogId,
            );
        }

        return [...groups.values()];
    }

    async merge(input: {
        keepId: number;
        mergeIds: number[];
        dryRun?: boolean;
    }): Promise<MergeResult> {
        const mergeIds = [...new Set(input.mergeIds)];

        if (mergeIds.length === 0) {
            throw new BadRequestException('Chưa chọn môn nào để gộp');
        }
        if (mergeIds.includes(input.keepId)) {
            throw new BadRequestException(
                'Môn giữ lại không được nằm trong danh sách môn bị gộp',
            );
        }

        return this.dataSource.transaction(async (manager) => {
            const subjects = await manager.query(
                `SELECT id, name, school_id AS "schoolId", school_year AS "schoolYear"
                 FROM subjects WHERE id = ANY($1::int[])`,
                [[input.keepId, ...mergeIds]],
            );

            if (subjects.length !== mergeIds.length + 1) {
                throw new BadRequestException('Có môn học không tồn tại');
            }

            // Gộp môn khác trường/khác năm học là trộn hợp đồng của hai nơi vào
            // nhau — sai nghiệp vụ, không có cách nào hoàn tác.
            const keep = subjects.find((s: any) => Number(s.id) === input.keepId);
            const different = subjects.filter(
                (s: any) =>
                    Number(s.schoolId) !== Number(keep.schoolId) ||
                    s.schoolYear !== keep.schoolYear,
            );
            if (different.length > 0) {
                throw new BadRequestException(
                    'Chỉ gộp được các môn của cùng một trường và cùng năm học',
                );
            }

            const refs = await this.referencingTables(manager);
            const moved = await this.countReferences(refs, mergeIds, manager);

            if (input.dryRun) {
                return {
                    dryRun: true,
                    keepId: input.keepId,
                    mergedIds: mergeIds,
                    moved,
                    deletedSubjects: mergeIds.length,
                };
            }

            // Chuyển tham chiếu TRƯỚC khi xoá. Đảo thứ tự là mất dữ liệu ở các
            // bảng đặt ON DELETE CASCADE.
            for (const ref of refs) {
                await manager.query(
                    `UPDATE "${ref.table}" SET "${ref.column}" = $1
                     WHERE "${ref.column}" = ANY($2::int[])`,
                    [input.keepId, mergeIds],
                );
            }

            await manager.query(`DELETE FROM subjects WHERE id = ANY($1::int[])`, [
                mergeIds,
            ]);

            this.logger.log(
                `Gộp môn ${mergeIds.join(', ')} vào ${input.keepId}; ` +
                    `chuyển ${JSON.stringify(moved)}`,
            );

            return {
                dryRun: false,
                keepId: input.keepId,
                mergedIds: mergeIds,
                moved,
                deletedSubjects: mergeIds.length,
            };
        });
    }

    private async countReferences(
        refs: SubjectReference[],
        subjectIds: number[],
        manager?: EntityManager,
    ): Promise<Record<string, number>> {
        const runner = manager ?? this.dataSource.manager;
        const out: Record<string, number> = {};

        for (const ref of refs) {
            const [{ count }] = await runner.query(
                `SELECT COUNT(*)::int AS count FROM "${ref.table}"
                 WHERE "${ref.column}" = ANY($1::int[])`,
                [subjectIds],
            );
            out[ref.table] = Number(count);
        }

        return out;
    }
}
