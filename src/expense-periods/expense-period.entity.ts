import {
    Column,
    CreateDateColumn,
    Entity,
    OneToMany,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';


@Entity('expense_periods')
export class ExpensePeriod {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column()
    month!: number;

    @Column()
    year!: number;

    @Column({
        nullable: true,
    })
    name!: string;

    // 1 OPEN
    // 2 LOCKED
    @Column({
        default: 1,
    })
    status!: number;

    @OneToMany(
        () => SchoolExpense,
        (item) => item.period,
    )
    schoolExpenses!: SchoolExpense[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}