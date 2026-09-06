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

    @CreateDateColumn({ name: 'created_at' })
    createdAt!: Date;

    @UpdateDateColumn({ name: 'updated_at' })
    updatedAt!: Date;
}
