import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

@Entity('zalo_tokens')
export class ZaloToken {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'text' })
    access_token!: string;

    @Column({ type: 'text' })
    refresh_token!: string;

    @Column({ nullable: true })
    expires_in!: number;

    @Column({ type: 'bigint', nullable: true })
    expires_at!: number;

    @CreateDateColumn()
    created_at!: Date;

    @UpdateDateColumn()
    updated_at!: Date;
}