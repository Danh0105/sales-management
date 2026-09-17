import { numericTransformer } from '../../utils/numeric-transformer';
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Subject } from '../../subject/subject.entity';
import { PolicyStatus } from '../policy.enum';

/** 3 nhóm file đính kèm của một Policy. */
export const POLICY_CONTRACT_CATEGORIES = ['CONTRACT', 'BBCS', 'HANDOVER_IMAGE'] as const;
export type PolicyContractCategory = (typeof POLICY_CONTRACT_CATEGORIES)[number];

/** Mặc định khi file cũ (trước khi có trường category) không có category. */
export const DEFAULT_POLICY_CONTRACT_CATEGORY: PolicyContractCategory = 'CONTRACT';

/** Một file hợp đồng trong `Policy.contractFiles`. */
export interface PolicyContractFile {
    id: string;
    url: string;
    originalName: string;
    size: number;
    uploadedById: number;
    uploadedByName?: string;
    uploadedAt: string;
    /** Nhóm file. Bản ghi cũ không có field này -> coi như 'CONTRACT' khi đọc. */
    category?: PolicyContractCategory;
}

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

    @Column({ name: 'contract_file_url', nullable: true })
    contractFileUrl?: string;

    @Column({ name: 'contract_file_name', nullable: true })
    contractFileName?: string;

    @Column({ name: 'contract_uploaded_by_id', nullable: true })
    contractUploadedById?: number;

    @Column({ name: 'contract_uploaded_by_name', nullable: true })
    contractUploadedByName?: string;

    @Column({ name: 'contract_uploaded_at', type: 'timestamptz', nullable: true })
    contractUploadedAt?: Date;

    /**
     * Danh sách hợp đồng PDF — một chính sách có thể kèm nhiều file (hợp đồng
     * chính, phụ lục, biên bản...). Các cột `contract_*` phía trên được giữ
     * lại và luôn phản chiếu **file mới nhất** để FE cũ chỉ đọc một file
     * không phải sửa gì.
     */
    @Column({ name: 'contract_files', type: 'jsonb', nullable: true })
    contractFiles?: PolicyContractFile[] | null;

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
