// app-version.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('app_version')
export class AppVersion {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    version!: string;

    @Column()
    apkUrl!: string;

    @Column({ default: false })
    isForce!: boolean;

    @Column({ nullable: true })
    note!: string;

    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;
}