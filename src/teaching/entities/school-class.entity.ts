import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    OneToMany,
    ManyToMany,
    JoinTable,
    Index,
} from 'typeorm';
import { School } from '../../school/schools.entity';
import { SchoolLocation } from '../../school-location/entities/school-location.entity';
import { TeachingSchedule } from './teaching-schedule.entity';
import { Subject } from '../../subject/subject.entity';

/**
 * Lớp học của một trường (VD: "1A", "Lá 1") do phòng Nhân sự khai báo.
 *
 * Lịch dạy được xếp cho **lớp**, không phải cho trường: một trường có nhiều lớp
 * học cùng một môn ở các khung giờ khác nhau nên nếu chỉ gắn theo trường thì
 * không biết buổi đó dạy lớp nào, và không chặn được việc xếp hai buổi trùng
 * giờ cho cùng một lớp.
 *
 * `schoolYear` là một phần định danh của lớp ("1A" năm 2025-2026 khác "1A" năm
 * 2026-2027) nên nằm trong unique key cùng `schoolId` + `name`.
 */
/**
 * Chống trùng tên lớp bằng HAI partial unique index thay vì một index thường:
 * - Lớp đã gắn điểm trường: trùng được xét trong phạm vi từng cơ sở, nên hai cơ
 *   sở của cùng một trường đều được có lớp "1A".
 * - Lớp chưa gắn điểm trường: giữ nguyên ràng buộc cũ theo trường.
 *
 * Phải tách đôi vì Postgres coi mỗi NULL là khác nhau: một index 4 cột thường sẽ
 * cho tạo trùng "1A" nhiều lần ở các lớp chưa gắn cơ sở. Dùng `where` (partial
 * index) thay cho COALESCE vì TypeORM diễn tả được `where` — index nào TypeORM
 * không hiểu thì `synchronize: true` sẽ DROP mất ở lần khởi động kế tiếp.
 */
@Entity('school_classes')
@Index(
    'UQ_school_classes_location_name_year',
    ['schoolId', 'schoolLocationId', 'name', 'schoolYear'],
    { unique: true, where: '"school_location_id" IS NOT NULL' },
)
@Index('UQ_school_classes_school_name_year', ['schoolId', 'name', 'schoolYear'], {
    unique: true,
    where: '"school_location_id" IS NULL',
})
export class SchoolClass {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ name: 'school_id' })
    @Index('IDX_school_classes_school_id')
    schoolId!: number;

    @ManyToOne(() => School, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'school_id' })
    school!: School;

    @Column({ name: 'school_location_id', type: 'int', nullable: true })
    @Index('IDX_school_classes_school_location_id')
    schoolLocationId?: number | null;

    @ManyToOne(() => SchoolLocation, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_location_id' })
    schoolLocation?: SchoolLocation | null;

    /** Tên lớp trong trường: "1A", "5/2", "Lá 1"… */
    @Column({ type: 'varchar', length: 100 })
    name!: string;

    /** Khối 1–12; null với mầm non hoặc trường không dùng khối. */
    @Column({ name: 'grade_level', type: 'smallint', nullable: true })
    gradeLevel?: number | null;

    /** Cùng quy ước với subjects.school_year: "2026-2027", "Hè 2026-2027"… */
    @Column({ name: 'school_year', type: 'varchar', length: 20 })
    @Index('IDX_school_classes_school_year')
    schoolYear!: string;

    @Column({ name: 'student_count', type: 'int', default: 0 })
    studentCount!: number;

    /** Giáo viên chủ nhiệm phía trường — chỉ là tên để liên hệ, không phải hồ sơ `teachers`. */
    @Column({ name: 'homeroom_teacher', type: 'varchar', length: 255, nullable: true })
    homeroomTeacher?: string | null;

    /** false = lớp đã kết thúc: không xếp lịch mới được, dữ liệu cũ vẫn giữ. */
    @Column({ name: 'is_active', type: 'boolean', default: true })
    @Index('IDX_school_classes_is_active')
    isActive!: boolean;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    /** Các môn được tổ chức dạy tại lớp này. */
    @ManyToMany(() => Subject)
    @JoinTable({
        name: 'school_class_subjects',
        joinColumn: { name: 'class_id', referencedColumnName: 'id' },
        inverseJoinColumn: { name: 'subject_id', referencedColumnName: 'id' },
    })
    subjects!: Subject[];

    @OneToMany(() => TeachingSchedule, (schedule) => schedule.class)
    schedules!: TeachingSchedule[];

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}

/** Chuẩn hoá tên lớp: bỏ khoảng trắng thừa để so sánh/lưu nhất quán. */
export function normalizeClassName(name: string): string {
    return (name ?? '').replace(/\s+/g, ' ').trim();
}
