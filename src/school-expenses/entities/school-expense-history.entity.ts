import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { SchoolExpense } from './school-expenses.entity';

@Entity('school_expense_history')
export class SchoolExpenseHistory {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => SchoolExpense, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_expense_id' })
  schoolExpense!: SchoolExpense;

  @Column()
  schoolExpenseId!: number;

  @Column({ nullable: true })
  updatedById?: number;

  @Column({ nullable: true })
  updatedByName?: string;

  @Column({ default: 'UPDATE' })
  action!: string;

  @Column({ type: 'varchar', default: 'school_expense' })
  entityType!: string;

  @Column({ type: 'json', nullable: true })
  oldData: any;

  @Column({ type: 'json', nullable: true })
  newData: any;

  @CreateDateColumn()
  createdAt!: Date;
}
