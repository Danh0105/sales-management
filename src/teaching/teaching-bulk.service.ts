import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { ClassInfo, SubjectResolverService } from './subject-resolver.service';
import { TeachingScheduleService } from './teaching-schedule.service';
import { TeachingSessionService } from './teaching-session.service';
import {
    BulkCreateSchedulesDto,
    BulkCreateSessionsDto,
    BulkSessionItemDto,
    MAX_BULK_SESSIONS,
} from './dto/teaching-bulk.dto';
import { assertDateOrder, assertTimeOrder } from './teaching.util';
import { DAY_OF_WEEK_LABELS } from './teaching.enum';

export interface BulkResultRow {
    classId: number;
    className: string | null;
    schoolId: number | null;
    schoolName: string | null;
    status: 'CREATED' | 'SKIPPED';
    reason?: string;
    subjectId?: number;
    subjectName?: string;
    /**
     * Id lịch vừa tạo (chỉ có ở dòng `CREATED`). Nhật ký thao tác đọc lại đúng
     * các bản ghi này để chốt trường/lớp/môn/giáo viên — tin vào payload thì
     * sai, vì môn được tra từ `catalogId` chứ client không gửi `subjectId`.
     */
    scheduleId?: number;
}

/**
 * Tạo lịch/tiết hàng loạt: một môn áp cho nhiều lớp của nhiều trường trong một
 * lần gọi, thay vì Nhân sự mở từng trường chọn lại môn.
 *
 * Khoá của thiết kế là `catalogId`: môn của **trường** (`subjects`) là bản ghi
 * riêng cho từng trường kèm hợp đồng/số tiết, nên không dùng chung được. Nhân sự
 * chọn môn trong **danh mục dùng chung** (`subject_catalogs`), backend tự tra ra
 * môn tương ứng của từng trường theo năm học của lớp.
 *
 * Mỗi dòng được tạo qua đúng service tạo đơn lẻ nên mọi quy tắc (môn thuộc
 * trường, giáo viên/lớp trùng giờ, lớp ngừng dùng…) giữ nguyên, không nhân bản
 * logic. Lỗi nghiệp vụ của một lớp chỉ làm lớp đó bị bỏ qua — phần còn lại vẫn
 * chạy, vì chặn cả lô chỉ vì một trường chưa khai môn là vô ích với Nhân sự.
 */
@Injectable()
export class TeachingBulkService {
    constructor(
        private readonly subjectResolver: SubjectResolverService,
        private readonly scheduleService: TeachingScheduleService,
        private readonly sessionService: TeachingSessionService,
    ) { }

    async createSchedules(dto: BulkCreateSchedulesDto) {
        const items = dto.items;

        if (dto.generateSessions) {
            assertDateOrder(
                dto.generateSessions.fromDate,
                dto.generateSessions.toDate,
                'fromDate phải nhỏ hơn hoặc bằng toDate',
            );
        }

        // Gộp mặc định cấp lô với override từng lớp, rồi kiểm tra hết trước khi
        // ghi: thiếu field là lỗi phía client, không nên ghi được nửa lô rồi 400.
        const merged = items.map((item) => ({
            item,
            values: {
                teacherId: item.teacherId ?? dto.teacherId,
                dayOfWeek: item.dayOfWeek ?? dto.dayOfWeek,
                startTime: item.startTime ?? dto.startTime,
                endTime: item.endTime ?? dto.endTime,
                periods: item.periods ?? dto.periods,
                effectiveFrom: item.effectiveFrom ?? dto.effectiveFrom,
                effectiveTo: item.effectiveTo ?? dto.effectiveTo,
                note: item.note ?? dto.note,
            },
        }));

        merged.forEach(({ item, values }) => {
            const label = `lớp #${item.classId}`;
            this.assertPresent(values.teacherId, 'teacherId', label);
            this.assertPresent(values.dayOfWeek, 'dayOfWeek', label);
            this.assertPresent(values.startTime, 'startTime', label);
            this.assertPresent(values.endTime, 'endTime', label);
            this.assertPresent(values.effectiveFrom, 'effectiveFrom', label);

            assertTimeOrder(values.startTime!, values.endTime!);
            assertDateOrder(values.effectiveFrom, values.effectiveTo);
        });

        this.assertUniqueSlots(
            merged.map(({ item, values }) => ({
                classId: item.classId,
                key: `${item.classId}|${values.dayOfWeek}|${values.startTime}`,
                slot: `${DAY_OF_WEEK_LABELS[values.dayOfWeek!] ?? `thứ ${values.dayOfWeek}`}, ${values.startTime}`,
            })),
        );

        const classes = await this.subjectResolver.loadClasses(items.map((i) => i.classId));
        const subjects = await this.subjectResolver.resolveSubjects(dto, items, classes);

        const results: BulkResultRow[] = [];
        const createdScheduleIds: number[] = [];

        for (const { item, values } of merged) {
            const info = classes.get(item.classId);

            if (!info) {
                results.push(this.skipped(item.classId, null, 'Lớp học không tồn tại'));
                continue;
            }

            const subject = subjects.get(item.classId)!;

            if (subject.status !== 'RESOLVED') {
                results.push(this.skipped(item.classId, info, subject.reason));
                continue;
            }

            try {
                const created = await this.scheduleService.create({
                    teacherId: values.teacherId!,
                    classId: item.classId,
                    subjectId: subject.subjectId,
                    dayOfWeek: values.dayOfWeek!,
                    startTime: values.startTime!,
                    endTime: values.endTime!,
                    periods: values.periods,
                    effectiveFrom: values.effectiveFrom!,
                    effectiveTo: values.effectiveTo,
                    isActive: dto.isActive,
                    note: values.note,
                });

                createdScheduleIds.push(created.id);
                results.push({
                    scheduleId: created.id,
                    classId: item.classId,
                    className: info.name,
                    schoolId: info.schoolId,
                    schoolName: info.schoolName,
                    status: 'CREATED',
                    subjectId: created.subjectId,
                    subjectName: created.subjectName,
                });
            } catch (error) {
                results.push(this.skipped(item.classId, info, this.messageOf(error)));
            }
        }

        let sessionsCreated = 0;

        if (dto.generateSessions && createdScheduleIds.length > 0) {
            for (const scheduleId of createdScheduleIds) {
                const generated = await this.scheduleService.generateSessions(
                    scheduleId,
                    dto.generateSessions,
                );
                sessionsCreated += generated.created;
            }
        }

        return {
            created: createdScheduleIds.length,
            skipped: results.length - createdScheduleIds.length,
            sessionsCreated,
            results,
        };
    }

    async createSessions(dto: BulkCreateSessionsDto) {
        const items = dto.items;
        const dates = this.resolveDates(dto, items);

        const merged = items.map((item) => ({
            item,
            values: {
                teacherId: item.teacherId ?? dto.teacherId,
                startTime: item.startTime ?? dto.startTime,
                endTime: item.endTime ?? dto.endTime,
                periods: item.periods ?? dto.periods,
                note: item.note ?? dto.note,
                // Ngày riêng của lớp thì chỉ tạo đúng ngày đó, bỏ qua `dates` chung.
                dates: item.date ? [item.date] : dates,
            },
        }));

        merged.forEach(({ item, values }) => {
            const label = `lớp #${item.classId}`;
            this.assertPresent(values.startTime, 'startTime', label);
            this.assertPresent(values.endTime, 'endTime', label);

            if (values.dates.length === 0) {
                throw new BadRequestException(
                    `Thiếu date/dates cho ${label}`,
                );
            }

            assertTimeOrder(values.startTime!, values.endTime!);
        });

        this.assertUniqueSlots(
            merged.flatMap(({ item, values }) =>
                values.dates.map((date) => ({
                    classId: item.classId,
                    key: `${item.classId}|${date}|${values.startTime}`,
                    slot: `${date}, ${values.startTime}`,
                })),
            ),
        );

        const total = merged.reduce((sum, m) => sum + m.values.dates.length, 0);

        if (total > MAX_BULK_SESSIONS) {
            throw new BadRequestException(
                `Mỗi lần tạo tối đa ${MAX_BULK_SESSIONS} tiết (đang yêu cầu ${total})`,
            );
        }

        const classes = await this.subjectResolver.loadClasses(items.map((i) => i.classId));
        const subjects = await this.subjectResolver.resolveSubjects(dto, items, classes);

        const results: Array<BulkResultRow & { date: string }> = [];
        let created = 0;

        for (const { item, values } of merged) {
            const info = classes.get(item.classId);
            const subject = subjects.get(item.classId)!;

            for (const date of values.dates) {
                if (!info) {
                    results.push({
                        ...this.skipped(item.classId, null, 'Lớp học không tồn tại'),
                        date,
                    });
                    continue;
                }

                if (subject.status !== 'RESOLVED') {
                    results.push({
                        ...this.skipped(item.classId, info, subject.reason),
                        date,
                    });
                    continue;
                }

                try {
                    const session = await this.sessionService.create({
                        teacherId: values.teacherId ?? null,
                        assignmentStatus: dto.assignmentStatus,
                        classId: item.classId,
                        subjectId: subject.subjectId,
                        date,
                        startTime: values.startTime!,
                        endTime: values.endTime!,
                        periods: values.periods,
                        note: values.note,
                    });

                    created += 1;
                    results.push({
                        classId: item.classId,
                        className: info.name,
                        schoolId: info.schoolId,
                        schoolName: info.schoolName,
                        status: 'CREATED',
                        subjectId: session.subjectId,
                        subjectName: session.subjectName,
                        date,
                    });
                } catch (error) {
                    results.push({
                        ...this.skipped(item.classId, info, this.messageOf(error)),
                        date,
                    });
                }
            }
        }

        return {
            created,
            skipped: results.length - created,
            results,
        };
    }

    /**
     * Một lớp xuất hiện nhiều lần trong lô là chuyện bình thường của thời khoá
     * biểu: lớp đó học môn này 2 tiết/tuần ở hai khung giờ khác nhau. Vì vậy
     * khoá chống trùng là **cả ô lịch** (lớp + thứ/ngày + giờ bắt đầu) chứ
     * không phải riêng `classId` — chặn theo `classId` thì không nhập nổi một
     * thời khoá biểu thật, mà đó lại là đầu vào chính của luồng nhập từ ảnh.
     *
     * Trùng đúng một ô mới là gõ nhầm, và báo lỗi kèm ô nào để còn tìm ra dòng.
     */
    private assertUniqueSlots(
        rows: Array<{ classId: number; key: string; slot: string }>,
    ): void {
        const seen = new Set<string>();

        for (const row of rows) {
            if (seen.has(row.key)) {
                throw new BadRequestException(
                    `Lớp #${row.classId} bị lặp trong danh sách (${row.slot})`,
                );
            }
            seen.add(row.key);
        }
    }

    private resolveDates(
        dto: BulkCreateSessionsDto,
        items: BulkSessionItemDto[],
    ): string[] {
        const dates = [...new Set(dto.dates ?? (dto.date ? [dto.date] : []))].sort();

        if (dates.length === 0 && items.some((item) => !item.date)) {
            throw new BadRequestException(
                'Vui lòng chọn ngày dạy (date hoặc dates)',
            );
        }

        return dates;
    }

    private assertPresent(value: unknown, field: string, label: string) {
        if (value === undefined || value === null || value === '') {
            throw new BadRequestException(`Thiếu ${field} cho ${label}`);
        }
    }

    private skipped(
        classId: number,
        info: ClassInfo | null,
        reason: string,
    ): BulkResultRow {
        return {
            classId,
            className: info?.name ?? null,
            schoolId: info?.schoolId ?? null,
            schoolName: info?.schoolName ?? null,
            status: 'SKIPPED',
            reason,
        };
    }

    /** Message của Nest có thể là chuỗi hoặc mảng — gom về một dòng đọc được. */
    private messageOf(error: unknown): string {
        if (error instanceof HttpException) {
            const response = error.getResponse() as
                | string
                | { message?: string | string[] };

            if (typeof response === 'string') return response;

            const message = response?.message;
            if (Array.isArray(message)) return message.join('; ');
            if (message) return message;
        }

        return error instanceof Error ? error.message : 'Lỗi không xác định';
    }
}
