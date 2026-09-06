import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

import type { ExtractedPeriodTime, ExtractedTimetable } from '../timetable.types';

/** Những gì đã chốt được sau khi tra database và hỏi lại Nhân sự. */
export interface DraftResolution {
    schoolId: number | null;
    schoolName: string | null;
    subjectId: number | null;
    subjectName: string | null;
    teacherId: number | null;
    teacherName: string | null;
    schoolYear: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    /**
     * Nhân sự đã chốt "chạy vô thời hạn". Cần cờ riêng vì `effectiveTo = null`
     * còn mang nghĩa "chưa hỏi", và hai trạng thái đó không được lẫn nhau.
     */
    effectiveToUnbounded: boolean;
    /** Giờ tiết cuối cùng — gộp phần đọc từ ảnh với phần Nhân sự bổ sung qua chat. */
    periodTimes: ExtractedPeriodTime[];
}

export interface DraftMessage {
    role: 'user' | 'assistant';
    text: string;
    at: string;
}

export type DraftStatus = 'DRAFT' | 'COMMITTED' | 'CANCELLED';

/**
 * Một lần import thời khoá biểu từ ảnh, sống qua nhiều lượt chat cho tới khi
 * Nhân sự bấm xác nhận.
 *
 * Bản nháp tồn tại để **tách việc đọc ảnh khỏi việc ghi dữ liệu**: model đề
 * xuất, Nhân sự soi bảng preview rồi mới chốt. Nhờ vậy một ô đọc sai chỉ là một
 * dòng sai nhìn thấy được, không phải hàng chục bản ghi sai trong database.
 */
@Entity('timetable_drafts')
export class TimetableDraft {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'created_by_id' })
    @Index('IDX_timetable_drafts_created_by_id')
    createdById!: number;

    @Column({ type: 'varchar', length: 20, default: 'DRAFT' })
    status!: DraftStatus;

    /** Nguyên văn kết quả đọc ảnh — giữ lại để đối chiếu khi số liệu có vấn đề. */
    @Column({ type: 'jsonb' })
    extracted!: ExtractedTimetable;

    @Column({ type: 'jsonb' })
    resolution!: DraftResolution;

    @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
    messages!: DraftMessage[];

    /** Kết quả của lần commit: số lớp/lịch đã tạo, dòng nào bị bỏ qua và vì sao. */
    @Column({ type: 'jsonb', nullable: true })
    commitResult!: unknown | null;

    @Column({ name: 'committed_at', type: 'timestamptz', nullable: true })
    committedAt!: Date | null;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
