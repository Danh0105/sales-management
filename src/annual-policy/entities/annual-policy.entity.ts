import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { School } from '../../school/schools.entity';
import { AnnualPolicyStatus } from '../annual-policy.enum';

@Entity('annual_policy')
export class AnnualPolicy {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    schoolId!: number;

    @ManyToOne(() => School, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'schoolId' })
    school!: School;

    @Column({ name: 'school_year', length: 20 })
    schoolYear!: string;

    @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
    amount!: number;

    @Column({ type: 'text' })
    content!: string;

    @Column({
        type: 'enum',
        enum: AnnualPolicyStatus,
        default: AnnualPolicyStatus.PENDING,
    })
    status!: AnnualPolicyStatus;

    @Column({ type: 'text', nullable: true })
    note?: string;

    @Column()
    createdById!: number;

    @Column({ nullable: true })
    createdByName?: string;

    @Column({ nullable: true })
    reviewedById?: number;

    @Column({ nullable: true })
    reviewedByName?: string;

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

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
