import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SubjectMergeService } from './subject-merge.service';

/**
 * Bất biến quan trọng nhất của việc gộp môn: `policy`, `teaching_schedules` và
 * `teaching_sessions` đều đặt `ON DELETE CASCADE` trên `subject_id`, nên tham
 * chiếu **phải** được chuyển sang môn giữ lại trước khi xoá. Đảo thứ tự là mất
 * chính sách và toàn bộ lịch dạy, không có cách nào lấy lại.
 */

const REFS = [
    { table: 'policy', column: 'subjectId', deleteRule: 'CASCADE' },
    { table: 'teaching_sessions', column: 'subject_id', deleteRule: 'CASCADE' },
    { table: 'revenue_items', column: 'subject_id', deleteRule: 'NO ACTION' },
];

const SUBJECTS = [
    { id: 724, name: 'STEM', schoolId: 506, schoolYear: '2025-2026' },
    { id: 725, name: 'STEM', schoolId: 506, schoolYear: '2025-2026' },
    { id: 799, name: 'STEM', schoolId: 999, schoolYear: '2025-2026' },
];

/** Ghi lại mọi câu SQL theo đúng thứ tự để kiểm tra trình tự thao tác. */
function makeService(options: { subjects?: typeof SUBJECTS } = {}) {
    const sql: string[] = [];
    const rows = options.subjects ?? SUBJECTS;

    const query = async (text: string, params?: any[]) => {
        sql.push(text.replace(/\s+/g, ' ').trim());

        if (text.includes('information_schema')) return REFS;
        if (text.includes('FROM subjects WHERE id = ANY')) {
            const ids: number[] = params?.[0] ?? [];
            return rows.filter((s) => ids.includes(s.id));
        }
        if (text.includes('COUNT(*)::int')) return [{ count: 3 }];
        return [];
    };

    const manager = { query };
    const dataSource = {
        manager,
        transaction: async (fn: any) => fn(manager),
        query,
    } as unknown as DataSource;

    return { service: new SubjectMergeService(dataSource), sql };
}

describe('gộp môn học trùng nhau', () => {
    it('chuyển hết tham chiếu TRƯỚC khi xoá môn', async () => {
        const { service, sql } = makeService();

        await service.merge({ keepId: 724, mergeIds: [725], dryRun: false });

        const updates = sql
            .map((q, i) => ({ q, i }))
            .filter((x) => x.q.startsWith('UPDATE'));
        const deleteAt = sql.findIndex((q) => q.startsWith('DELETE FROM subjects'));

        expect(updates).toHaveLength(REFS.length);
        expect(deleteAt).toBeGreaterThan(-1);
        // Mọi UPDATE phải nằm trước DELETE — đây là thứ ngăn mất dữ liệu.
        for (const update of updates) {
            expect(update.i).toBeLessThan(deleteAt);
        }
    });

    it('chuyển tham chiếu cho đủ mọi bảng đọc từ metadata database', async () => {
        const { service, sql } = makeService();

        await service.merge({ keepId: 724, mergeIds: [725], dryRun: false });

        // Danh sách bảng lấy từ information_schema chứ không hard-code: thêm
        // khoá ngoại mới mà quên cập nhật code thì lần gộp sau mất dữ liệu.
        for (const ref of REFS) {
            expect(
                sql.some(
                    (q) => q.startsWith('UPDATE') && q.includes(`"${ref.table}"`),
                ),
            ).toBe(true);
        }
    });

    it('dry-run không ghi gì vào database', async () => {
        const { service, sql } = makeService();

        const result = await service.merge({
            keepId: 724,
            mergeIds: [725],
            dryRun: true,
        });

        expect(result.dryRun).toBe(true);
        expect(result.deletedSubjects).toBe(1);
        expect(sql.some((q) => q.startsWith('UPDATE'))).toBe(false);
        expect(sql.some((q) => q.startsWith('DELETE'))).toBe(false);
    });

    it('báo trước số dòng sẽ chuyển, theo từng bảng', async () => {
        const { service } = makeService();

        const result = await service.merge({
            keepId: 724,
            mergeIds: [725],
            dryRun: true,
        });

        expect(result.moved).toEqual({
            policy: 3,
            teaching_sessions: 3,
            revenue_items: 3,
        });
    });

    it('từ chối gộp môn của trường khác', async () => {
        const { service, sql } = makeService();

        await expect(
            service.merge({ keepId: 724, mergeIds: [799], dryRun: false }),
        ).rejects.toThrow(BadRequestException);

        // Đã chặn thì không được đụng tới dữ liệu.
        expect(sql.some((q) => q.startsWith('DELETE'))).toBe(false);
    });

    it('từ chối khi môn giữ lại nằm trong danh sách bị gộp', async () => {
        const { service } = makeService();

        await expect(
            service.merge({ keepId: 724, mergeIds: [724, 725], dryRun: false }),
        ).rejects.toThrow('Môn giữ lại không được nằm trong danh sách môn bị gộp');
    });

    it('từ chối khi không chọn môn nào', async () => {
        const { service } = makeService();

        await expect(
            service.merge({ keepId: 724, mergeIds: [], dryRun: false }),
        ).rejects.toThrow('Chưa chọn môn nào để gộp');
    });

    it('từ chối khi có môn không tồn tại', async () => {
        const { service, sql } = makeService();

        await expect(
            service.merge({ keepId: 724, mergeIds: [123456], dryRun: false }),
        ).rejects.toThrow('Có môn học không tồn tại');

        expect(sql.some((q) => q.startsWith('DELETE'))).toBe(false);
    });

    it('bỏ id trùng lặp trong danh sách gộp', async () => {
        const { service } = makeService();

        const result = await service.merge({
            keepId: 724,
            mergeIds: [725, 725, 725],
            dryRun: true,
        });

        expect(result.mergedIds).toEqual([725]);
        expect(result.deletedSubjects).toBe(1);
    });
});
