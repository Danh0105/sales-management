import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { Subject } from '../../subject/subject.entity';
import { SchoolExpense } from './school-expenses.entity';

/**
 * "Xác nhận đúng BBCS" bảng Chi Ngoài theo TỪNG MÔN của một bảng thu chi
 * (trường × kỳ). Trước 12/11/2026 cờ nằm ở `school_expenses` nên xác nhận một
 * môn khoá luôn mọi môn của trường.
 */
@Entity('school_expense_management_confirmations')
export class SchoolExpenseManagementConfirmation {
  @PrimaryColumn({ type: 'int', name: 'school_expense_id' })
  schoolExpenseId!: number;

  @ManyToOne(() => SchoolExpense, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_expense_id' })
  schoolExpense?: SchoolExpense;

  @PrimaryColumn({ type: 'int', name: 'subject_id' })
  subjectId!: number;

  @ManyToOne(() => Subject, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject?: Subject;

  @Column({ type: 'int', name: 'confirmed_by', nullable: true })
  confirmedBy!: number | null;

  @Column({ type: 'varchar', length: 255, name: 'confirmed_by_name', nullable: true })
  confirmedByName!: string | null;

  @Column({ type: 'timestamptz', name: 'confirmed_at' })
  confirmedAt!: Date;
}
