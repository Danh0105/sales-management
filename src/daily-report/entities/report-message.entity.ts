import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
    CreateDateColumn,
} from 'typeorm';
import { DailyReport } from './daily-report.entity';
import { Employee } from '../../employee/employee.entity';

export enum ReportMessageSenderRole {
    EMPLOYEE = 'EMPLOYEE',
    MANAGER = 'MANAGER',
}

@Entity('report_messages')
export class ReportMessage {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'text' })
    message!: string;

    @Column({
        type: 'enum',
        enum: ReportMessageSenderRole,
    })
    senderRole!: ReportMessageSenderRole;

    @ManyToOne(() => DailyReport, (report) => report.messages, {
        onDelete: 'CASCADE',
    })
    report!: DailyReport;

    @ManyToOne(() => Employee, {
        onDelete: 'CASCADE',
    })
    sender!: Employee;

    @CreateDateColumn()
    createdAt!: Date;
}