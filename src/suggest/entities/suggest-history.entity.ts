// suggest-history.entity.ts
import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
} from 'typeorm';

@Entity()
export class SuggestHistory {
    @PrimaryGeneratedColumn()
    id?: number;

    @Column()
    suggestId?: number;

    @CreateDateColumn()
    snapshotAt?: Date;

    @Column({ type: 'jsonb' })
    data: any;

    @Column({ default: 'CREATED' })
    action?: string;

    @Column({ nullable: true })
    userId?: number;

    // ===== audit trail cho luồng đề xuất chi =====

    @Column({ type: 'varchar', nullable: true })
    fromStatus?: string | null;

    @Column({ type: 'varchar', nullable: true })
    toStatus?: string | null;

    @Column({ type: 'text', nullable: true })
    note?: string | null;
}