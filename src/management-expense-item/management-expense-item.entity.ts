import {
  Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { ManagementExpenseOtherCost } from './management-expense-other-cost.entity';

@Entity('management_expense_items')
@Index(['schoolExpense', 'subject'])
export class ManagementExpenseItem {
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

  @Column({
    type: 'int',
    default: 0,
  })
  rowIndex!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  totalPeriods!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  studentCount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 1,
  })
  monthsCount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  ql1UnitPrice!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  ql2UnitPrice!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  ql1Amount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  ql2Amount!: number;

  // ===== Thuế (đơn giá thuế tuyệt đối; taxAmount = tax × HS × tháng) =====
  // taxAmount KHÔNG cộng vào totalOutside — chỉ để báo cáo (totalTaxAmount).

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  ql1Tax!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  ql2Tax!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  ql1TaxAmount!: number;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  ql2TaxAmount!: number;

  /** Tổng thuế của dòng = ql1TaxAmount + ql2TaxAmount + Σ otherCosts.taxAmount. */
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  totalTaxAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  totalOutside!: number;

  @Column({
    type: 'date',
    nullable: true,
  })
  collectedDate!: Date;

  @Column({
    type: 'date',
    nullable: true,
  })
  expenseDate!: Date;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  contractAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  invoiceAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  paidAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  remaining!: number;

  @Column({
    nullable: true,
  })
  payer!: string;

  @Column({
    type: 'text',
    nullable: true,
  })
  note!: string;

  @OneToMany(
    () => ManagementExpenseOtherCost,
    (oc) => oc.managementExpenseItem,
  )
  otherCosts!: ManagementExpenseOtherCost[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
