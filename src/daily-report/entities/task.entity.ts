import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    CreateDateColumn,
} from 'typeorm';
import { DailyReport } from './daily-report.entity';

@Entity('tasks')
export class Task {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ nullable: true })
    title!: string;

    @Column({ type: 'text', nullable: true })
    content!: string;

    @Column({ nullable: true })
    location!: string;

    @ManyToOne(() => DailyReport, (report) => report.tasks, {
        onDelete: 'CASCADE',
    })
    report!: DailyReport;

    @CreateDateColumn()
    createdAt!: Date;


}