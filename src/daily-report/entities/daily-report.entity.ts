import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    Index,
} from 'typeorm';
import { Task } from './task.entity';
import { Employee } from '../../employee/employee.entity';
import { ReportMessage } from './report-message.entity';
import { Province } from '../../province/province.entity';
import { School } from '../../school/schools.entity';


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

    @Column({ name: 'province_id', type: 'int', nullable: true })
    @Index('IDX_daily_reports_province_id')
    provinceId!: number | null;

    @ManyToOne(() => Province, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'province_id' })
    province?: Province | null;

    @Column({ name: 'school_id', type: 'int', nullable: true })
    @Index('IDX_daily_reports_school_id')
    schoolId!: number | null;

    @ManyToOne(() => School, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_id' })
    school?: School | null;


    @OneToMany(() => ReportMessage, (message) => message.report, {
        cascade: true,
    })
    messages!: ReportMessage[];
}
