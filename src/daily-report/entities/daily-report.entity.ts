import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
} from 'typeorm';
import { Task } from './task.entity';
import { Employee } from '../../employee/employee.entity';
import { ReportMessage } from './report-message.entity';


@Entity('daily_reports')
export class DailyReport {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'date' })
    date!: string;

    @OneToMany(() => Task, (task) => task.report, {
        cascade: true,
    })
    tasks!: Task[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @ManyToOne(() => Employee, (employee) => employee.dailyReports, {
        onDelete: 'CASCADE',
    })
    employee!: Employee;


    @OneToMany(() => ReportMessage, (message) => message.report, {
        cascade: true,
    })
    messages!: ReportMessage[];
}