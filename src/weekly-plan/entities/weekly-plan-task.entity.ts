import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    ManyToOne,
} from 'typeorm';
import { WeeklyPlan } from './weekly-plan.entity';

@Entity('weekly_plan_tasks')
export class WeeklyPlanTask {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    title!: string;

    @Column({ type: 'text', nullable: true })
    content!: string;

    @Column()
    dayOfWeek!: number; // 1-7

    @ManyToOne(() => WeeklyPlan, (plan) => plan.tasks, {
        onDelete: 'CASCADE',
    })
    weeklyPlan!: WeeklyPlan;
}