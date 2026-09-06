import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
} from 'typeorm';

@Entity('weekly_plan_history')
export class WeeklyPlanHistory {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    weeklyPlanId?: number;

    @Column({ type: 'jsonb' })
    snapshot: any;

    @Column()
    version?: number;

    @Column({ nullable: true })
    createdBy?: number;

    @Column({ type: 'timestamp', default: () => 'now()' })
    createdAt?: Date;
}