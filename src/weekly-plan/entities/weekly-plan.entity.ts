import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    OneToMany,
} from 'typeorm';
import { WeeklyPlanTask } from './weekly-plan-task.entity';

@Entity('weekly_plans')
export class WeeklyPlan {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'date' })
    startDate?: string;

    @Column({ type: 'date' })
    endDate?: string;

    @Column({ nullable: true })
    employeeId?: number;

    @Column({ default: 'draft' })
    status?: string;

    @Column({ type: 'timestamp', default: () => 'now()' })
    createdAt?: Date;

    @Column({ type: 'timestamp', default: () => 'now()' })
    updatedAt?: Date;

    @OneToMany(() => WeeklyPlanTask, (task) => task.weeklyPlan, {
        cascade: true,
    })
    tasks?: WeeklyPlanTask[];
}