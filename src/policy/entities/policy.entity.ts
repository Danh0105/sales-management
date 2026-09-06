import { numericTransformer } from '../../utils/numeric-transformer';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Subject } from '../../subject/subject.entity';
import { PolicyStatus } from '../policy.enum';

@Entity()
@Index('IDX_policy_status', ['status'])
@Index('IDX_policy_created_at', ['createdAt'])
@Index('IDX_policy_status_created_at', ['status', 'createdAt'])
export class Policy {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    @Index('IDX_policy_subject_id')
    subjectId!: number;

    @ManyToOne(() => Subject, (subject) => subject.policies, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'subjectId' })
    subject!: Subject;

    @Column({ type: 'json' })
    data: any;

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;

    @Column({
        type: 'enum',
        enum: PolicyStatus,
        default: PolicyStatus.PENDING,
    })
    status!: PolicyStatus;

    @Column({ type: 'text', nullable: true })
    note?: string;

    @Column({ nullable: true })
    currentHistoryId?: number;

    /**
     * Số tháng áp dụng. Dùng `numeric` chứ không phải `int`: người dùng khai
     * thời hạn lẻ theo năm học (8.5 tháng, 3.4 tháng) — để `int` thì Postgres
     * ném lỗi kiểu và cả request tạo chính sách hỏng với 500.
     */
    @Column({
        name: 'duration_months',
        type: 'numeric',
        precision: 6,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    durationMonths!: number;
}