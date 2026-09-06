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
import {
  normalizeRevenueInvoiceStatus,
  RevenueInvoiceStatus,
  RevenueInvoiceType,
} from './revenue-invoice-status.enum';

@Entity('revenue_items')
@Index(['schoolExpense', 'subject'])
export class RevenueItem {
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
    type: 'varchar',
    length: 500,
    nullable: true,
    default: '',
  })
  content!: string;

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
  unitPrice!: number;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  invoiceAmount!: number;

  @Column({
    type: 'varchar',
    length: 20,
    default: RevenueInvoiceStatus.Select,
    transformer: {
      to: normalizeRevenueInvoiceStatus,
      from: normalizeRevenueInvoiceStatus,
    },
  })
  invoiced!: RevenueInvoiceStatus;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    default: RevenueInvoiceType.Empty,
  })
  invoiceType!: RevenueInvoiceType;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  invoiceOther!: string | null;

  @Column({
    type: 'date',
    nullable: true,
  })
  invoiceDate!: Date | null;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  paidAmount!: number;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  paymentMethod!: string | null;

  @Column({
    type: 'date',
    nullable: true,
  })
  paymentDate!: Date | null;

  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
  })
  remainingAmount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
