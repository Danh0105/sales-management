import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';

import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Entity('expense_items')
export class ExpenseItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @ManyToOne(() => SchoolExpense, {
        nullable: false,
        onDelete: 'CASCADE',
    })
    @JoinColumn({
        name: 'school_expense_id',
    })
    schoolExpense!: SchoolExpense;

    @ManyToOne(() => Subject)
    @JoinColumn({
        name: 'subject_id',
    })
    subject!: Subject;

    // Số tiết
    @Column({
        type: 'int',
        default: 0,
    })
    totalPeriods!: number;
    // Số học sinh
    @Column({
        type: 'int',
        default: 0,
    })
    studentCount!: number;
    // Số tiền hoá đơn
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    invoiceAmount!: number;

    // Ngày thu tiền
    @Column({
        type: 'date',
        nullable: true,
    })
    collectedDate!: Date;

    // Tổng chi ngoài HĐ
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    totalOutsideExpense!: number;

    // Đã chi
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    paidAmount!: number;

    // Còn phải chi ngoài HĐ
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    remainingOutsideExpense!: number;

    // Ngày chi
    @Column({
        type: 'date',
        nullable: true,
    })
    paymentDate!: Date;

    // Người chi
    @Column({
        nullable: true,
    })
    payer!: string;

    // Doanh thu
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    revenueAmount!: number;

    // Chi phí
    @Column({
        type: 'decimal',
        precision: 15,
        scale: 2,
        default: 0,
    })
    expenseAmount!: number;

    @Column({
        type: 'text',
        nullable: true,
    })
    note!: string;

}