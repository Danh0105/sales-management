import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { ExpensePeriod } from '../../expense-periods/expense-period.entity';
import { School } from '../../school/schools.entity';
import { ExpenseItem } from '../../expense-item/expense-item.entity';
import { CashPolicyItem } from '../../cash-policy-item/cash-policy-item.entity';
import { RevenueItem } from '../../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../../school-expense-item/school-expense-item.entity';
import { ManagementExpenseItem } from '../../management-expense-item/management-expense-item.entity';





@Entity('school_expenses')
export class SchoolExpense {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(
        () => ExpensePeriod,
        {
            nullable: false,
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({
        name: 'period_id',
    })
    period!: ExpensePeriod;

    @ManyToOne(
        () => School,
        {
            nullable: false,
            onDelete: 'CASCADE',
        },
    )
    @JoinColumn({
        name: 'school_id',
    })
    school!: School;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    totalRevenue!: number;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    totalExpense!: number;

    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    totalCashPolicy!: number;

    @OneToMany(
        () => ExpenseItem,
        (item) => item.schoolExpense,
    )
    expenseItems!: ExpenseItem[];

    @OneToMany(
        () => CashPolicyItem,
        (item) => item.schoolExpense,
    )
    cashPolicyItems!: CashPolicyItem[];

    @OneToMany(
        () => RevenueItem,
        (item) => item.schoolExpense,
    )
    revenueItems!: RevenueItem[];

    @OneToMany(
        () => SchoolExpenseItem,
        (item) => item.schoolExpense,
    )
    schoolExpenseItems!: SchoolExpenseItem[];

    @OneToMany(
        () => ManagementExpenseItem,
        (item) => item.schoolExpense,
    )
    managementExpenseItems!: ManagementExpenseItem[];

    /**
     * Sales admin xác nhận bảng "Chi Ngoài" (management_expense_items) →
     * khoá chỉnh sửa; sau khi khoá chỉ kế toán trưởng (ketoan_truong) được sửa.
     */
    @Column({
        type: 'boolean',
        name: 'management_expense_confirmed',
        default: false,
    })
    managementExpenseConfirmed!: boolean;

    @Column({
        type: 'int',
        name: 'management_expense_confirmed_by',
        nullable: true,
    })
    managementExpenseConfirmedBy?: number | null;

    @Column({
        type: 'varchar',
        name: 'management_expense_confirmed_by_name',
        nullable: true,
    })
    managementExpenseConfirmedByName?: string | null;

    @Column({
        type: 'timestamptz',
        name: 'management_expense_confirmed_at',
        nullable: true,
    })
    managementExpenseConfirmedAt?: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}