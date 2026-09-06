import {
  Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Entity('school_expense_items')
@Index(['schoolExpense', 'subject'])
export class SchoolExpenseItem {
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
  csvc!: number;

  @Column({
    name: 'teacher_unit_price',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  giaovien!: number;

  @Column({
    name: 'tax_unit_price',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  thue!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  teacherAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  taxAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  csvcAmount!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  schoolExpenseAmount!: number;

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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
