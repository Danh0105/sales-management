import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    JoinColumn,
    OneToMany,
    Index,
} from 'typeorm';
import { School } from '../school/schools.entity';
import { SchoolLocation } from '../school-location/entities/school-location.entity';
import { Policy } from '../policy/entities/policy.entity';
import { SubjectCatalog } from '../subject-catalog/subject-catalog.entity';
import { numericTransformer } from '../utils/numeric-transformer';

@Entity('subjects')
export class Subject {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    name!: string;

    @Column({ length: 50, nullable: true })
    code!: string;

    @ManyToOne(() => School, (s) => s.subjects, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'school_id' })
    school!: School;

    @Column({ name: 'school_id' })
    @Index('IDX_subjects_school_id')
    schoolId!: number;

    @Column({ name: 'school_location_id', type: 'int', nullable: true })
    @Index('IDX_subjects_school_location_id')
    schoolLocationId?: number | null;

    @ManyToOne(() => SchoolLocation, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_location_id' })
    schoolLocation?: SchoolLocation | null;

    @Column({
        name: 'class_count',
        type: 'int',
        default: 0,
    })
    classCount!: number;

    @Column({ name: 'created_at', type: 'timestamp', default: () => 'now()' })
    createdAt!: Date;

    @Column({ name: 'student_count', type: 'int', default: 0 })
    studentCount!: number;

    @Column({ name: 'total_lessons', type: 'int', default: 0 })
    totalLessons!: number;

    @Column({ name: 'contract_number', type: 'varchar', length: 100, nullable: true })
    contractNumber!: string;

    /**
     * Thời hạn hợp đồng/phụ lục — `numeric` chứ không phải `int` vì thực tế
     * khai cả giá trị lẻ (8.5), để `int` là Postgres ném lỗi kiểu và hỏng cả
     * request tạo môn học.
     */
    @Column({
        name: 'contract_years',
        type: 'numeric',
        precision: 6,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    contractDuration!: number;

    @Column({
        name: 'appendix_years',
        type: 'numeric',
        precision: 6,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    appendixDuration!: number;

    @Column({ name: 'start_date', type: 'date', nullable: true })
    startDate!: Date;

    @OneToMany(() => Policy, (policy) => policy.subject)
    policies!: Policy[];

    @Column({ name: 'school_year', type: 'varchar', length: 20, nullable: true })
    @Index('IDX_subjects_school_year')
    schoolYear!: string;

    /**
     * Môn trong danh mục (sales admin tạo) mà môn học này được chọn từ.
     * Nullable để giữ nguyên dữ liệu cũ nhập tay chưa map được vào danh mục.
     */
    @ManyToOne(() => SubjectCatalog, (c) => c.subjects, {
        nullable: true,
        onDelete: 'SET NULL',
    })
    @JoinColumn({ name: 'catalog_id' })
    catalog?: SubjectCatalog | null;

    @Column({ name: 'catalog_id', type: 'int', nullable: true })
    @Index('IDX_subjects_catalog_id')
    catalogId?: number | null;

    /**
     * Đơn giá mỗi tiết dạy môn này tại trường này. Do Nhân sự khai — thay cho
     * đơn giá theo giáo viên/mẫu lịch trước đây (đã bỏ). `TeachingSession`
     * chốt giá trị này vào `ratePerPeriod` tại thời điểm tạo buổi.
     */
    @Column({
        name: 'rate_per_period',
        type: 'decimal',
        precision: 15,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    ratePerPeriod?: number | null;

}