import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { Subject } from '../subject/subject.entity';

/**
 * "Duyệt lương" bảng Giáo viên trường của một môn trong một bảng thu chi: chỉ
 * ghi người + thời điểm duyệt, không khoá bảng. Số tiền đổi thì xoá dòng này.
 */
@Entity('school_teacher_payroll_approvals')
export class SchoolTeacherPayrollApproval {
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

  @Column({ type: 'int', name: 'approved_by', nullable: true })
  approvedBy!: number | null;

  @Column({ type: 'varchar', length: 255, name: 'approved_by_name', nullable: true })
  approvedByName!: string | null;

  @Column({ type: 'timestamptz', name: 'approved_at' })
  approvedAt!: Date;
}
