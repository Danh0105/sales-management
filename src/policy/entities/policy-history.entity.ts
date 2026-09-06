import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    Index,
    ManyToOne,
    JoinColumn,
} from 'typeorm';
import { Policy } from './policy.entity';
import { PolicyStatus } from '../policy.enum';

@Entity('policy_history')
export class PolicyHistory {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => Policy, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'policyId' })
    policy!: Policy;

    @Column()
    policyId!: number;


    @Column({ nullable: true })
    updatedBy?: string;

    @Column({ default: 'UPDATE' })
    action!: 'CREATE' | 'UPDATE' | 'DELETE' | 'ADMIN_UPDATE' | 'AUTO_APPROVED' | 'SAVE_DRAFT' | 'DIRECTOR_UPDATE' | 'SALES_ADMIN_UPDATE';

    @Column({ type: 'json', nullable: true })
    oldData: any;

    @Column({ type: 'json', nullable: true })
    newData: any;

    @Column({ type: 'json', nullable: true })
    diff: any;

    @Column({ nullable: true })
    note?: string;

    @CreateDateColumn()
    createdAt!: Date;

    @Column({
        type: 'enum',
        enum: PolicyStatus,
        default: PolicyStatus.PENDING,
    })
    status!: PolicyStatus;
}
