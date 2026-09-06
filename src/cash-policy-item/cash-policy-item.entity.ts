import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';


@Entity('cash_policy_items')
export class CashPolicyItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(
        () => SchoolExpense,
        {
            nullable: false,
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({
        name: 'school_expense_id',
    })
    schoolExpense!: SchoolExpense;

    @Column({
        nullable: true,
    })
    payer!: string;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    cashPolicyAmount!: number;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    otherAmount!: number;

    @Column({
        type: 'date',
        nullable: true,
    })
    paymentDate!: Date;

    @Column({
        type: 'text',
        nullable: true,
    })
    note!: string;
}