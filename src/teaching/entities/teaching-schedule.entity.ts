import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    OneToMany,
    Index,
} from 'typeorm';
import { Teacher } from './teacher.entity';
import { School } from '../../school/schools.entity';
import { SchoolLocation } from '../../school-location/entities/school-location.entity';
import { SchoolClass } from './school-class.entity';
import { Subject } from '../../subject/subject.entity';
import { TeachingSession } from './teaching-session.entity';
import { ConfirmationStatus } from '../teaching.enum';

/**
 * Mẫu lịch lặp theo tuần: "Thứ 3, 07:30–09:00, từ 05/08/2026 đến 31/05/2027".
 * Buổi dạy cụ thể được sinh ra từ mẫu này sang bảng teaching_sessions.
 *
 * Lịch được xếp cho một **lớp** (`classId`); `schoolId` là trường của lớp đó,
 * giữ lại để lọc/thống kê theo trường mà không phải join thêm bảng.
 */
@Entity('teaching_schedules')
@Index('IDX_teaching_schedules_teacher_day', ['teacherId', 'dayOfWeek'])
export class TeachingSchedule {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'teacher_id' })
    @Index('IDX_teaching_schedules_teacher_id')
    teacherId!: number;

    @ManyToOne(() => Teacher, (teacher) => teacher.schedules, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'teacher_id' })
    teacher!: Teacher;

    @Column({ name: 'school_id' })
    @Index('IDX_teaching_schedules_school_id')
    schoolId!: number;

    @ManyToOne(() => School, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'school_id' })
    school!: School;

    @Column({ name: 'school_location_id', type: 'int', nullable: true })
    @Index('IDX_teaching_schedules_school_location_id')
    schoolLocationId?: number | null;

    @ManyToOne(() => SchoolLocation, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_location_id' })
    schoolLocation?: SchoolLocation | null;

    /** null = lịch cũ xếp theo trường, tạo trước khi có quản lý lớp học. */
    @Column({ name: 'class_id', type: 'int', nullable: true })
    @Index('IDX_teaching_schedules_class_id')
    classId?: number | null;

    @ManyToOne(() => SchoolClass, (schoolClass) => schoolClass.schedules, {
        nullable: true,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'class_id' })
    class?: SchoolClass | null;

    @Column({ name: 'subject_id' })
    @Index('IDX_teaching_schedules_subject_id')
    subjectId!: number;

    @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'subject_id' })
    subject!: Subject;

    /** 2 = Thứ Hai … 7 = Thứ Bảy, 8 = Chủ Nhật. */
    @Column({ name: 'day_of_week', type: 'smallint' })
    dayOfWeek!: number;

    @Column({ name: 'start_time', type: 'time' })
    startTime!: string;

    @Column({ name: 'end_time', type: 'time' })
    endTime!: string;

    @Column({ type: 'int', nullable: true })
    periods?: number | null;

    @Column({ name: 'effective_from', type: 'date' })
    effectiveFrom!: string;

    /** null = chưa có ngày kết thúc. */
    @Column({ name: 'effective_to', type: 'date', nullable: true })
    effectiveTo?: string | null;

    @Column({ name: 'is_active', type: 'boolean', default: true })
    isActive!: boolean;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    /** Giáo viên phải xác nhận/từ chối mẫu lịch này. */
    @Column({
        name: 'confirmation_status',
        type: 'enum',
        enum: ConfirmationStatus,
        default: ConfirmationStatus.PENDING,
    })
    confirmationStatus!: ConfirmationStatus;

    @Column({ name: 'confirmed_at', type: 'timestamp', nullable: true })
    confirmedAt?: Date | null;

    /** Lý do từ chối — bắt buộc khi giáo viên từ chối. */
    @Column({ name: 'rejection_reason', type: 'text', nullable: true })
    rejectionReason?: string | null;

    /**
     * Thời điểm đã bắn cảnh báo "còn chưa xác nhận, sắp tới buổi dạy".
     * Khoá chống gửi trùng — cùng cơ chế với `TeachingSession.checkinAlertAt`.
     */
    @Column({ name: 'confirmation_alert_at', type: 'timestamp', nullable: true })
    confirmationAlertAt?: Date | null;

    @OneToMany(() => TeachingSession, (session) => session.schedule)
    sessions!: TeachingSession[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
