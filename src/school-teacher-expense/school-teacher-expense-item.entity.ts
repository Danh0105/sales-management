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

import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { Subject } from '../subject/subject.entity';
import { numericTransformer } from '../utils/numeric-transformer';
import { SchoolTeacher } from './school-teacher.entity';

/**
 * Bảng "Giáo viên trường" (dưới Chi Ngoài): lương trả thẳng cho giáo viên của
 * trường, khấu trừ thuế TNCN. Từ kỳ tháng 11/2026 phần này tách khỏi Chi Trường.
 * Dòng đi kèm dòng Doanh Thu cùng `rowIndex` (dùng chung Nội dung / số lượng);
 * dòng thêm riêng (rowIndex ≥ số dòng Doanh Thu) tự giữ Nội dung và số lượng.
 */
@Entity('school_teacher_expense_items')
@Index('IDX_school_teacher_expense_items_sheet_subject', ['schoolExpenseId', 'subjectId'])
export class SchoolTeacherExpenseItem {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', name: 'school_expense_id' })
  schoolExpenseId!: number;

  @ManyToOne(() => SchoolExpense, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_expense_id' })
  schoolExpense?: SchoolExpense;

  @Column({ type: 'int', name: 'subject_id' })
  subjectId!: number;

  @ManyToOne(() => Subject, { nullable: false })
  @JoinColumn({ name: 'subject_id' })
  subject?: Subject;

  @Column({ type: 'int', name: 'row_index', default: 0 })
  rowIndex!: number;

  /** Giáo viên nhận lương (danh sách giáo viên của trường); null = chưa chọn. */
  @Column({ type: 'int', name: 'school_teacher_id', nullable: true })
  schoolTeacherId!: number | null;

  @ManyToOne(() => SchoolTeacher, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'school_teacher_id' })
  schoolTeacher?: SchoolTeacher | null;

  /** Nội dung riêng — chỉ dòng thêm riêng; dòng đi kèm Doanh Thu dùng Nội dung của Doanh Thu. */
  @Column({ type: 'text', nullable: true })
  content!: string | null;

  @Column({ name: 'total_periods', type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  totalPeriods!: number;

  @Column({ name: 'student_count', type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  studentCount!: number;

  @Column({ name: 'months_count', type: 'numeric', precision: 15, scale: 4, default: 1, transformer: numericTransformer })
  monthsCount!: number;

  /** Đơn giá — mặc định "Giáo viên trường" của chính sách. */
  @Column({ name: 'unit_price', type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  unitPrice!: number;

  /** Thành tiền = Đơn giá × (Số HS, không có thì Số tiết) × Số tháng. */
  @Column({ type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  amount!: number;

  /**
   * % thuế TNCN đang áp cho dòng: 10 khi tổng thù lao tháng của giáo viên trong
   * bảng thu chi (mọi môn) từ 5.000.000đ, ngược lại 0. Server tự tính.
   */
  /** Thuế TNCN do kế toán nhập tay (19/11/2026): giữ đúng `pitAmount`, không tự tính. */
  @Column({ name: 'pit_manual', type: 'boolean', default: false })
  pitManual!: boolean;

  @Column({ name: 'pit_rate', type: 'numeric', precision: 5, scale: 2, default: 0, transformer: numericTransformer })
  pitRate!: number;

  @Column({ name: 'pit_amount', type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  pitAmount!: number;

  /** Còn lại phải chi = Thành tiền − Thuế TNCN (số thực trả cho giáo viên). */
  @Column({ name: 'net_amount', type: 'numeric', precision: 15, scale: 2, default: 0, transformer: numericTransformer })
  netAmount!: number;

  /** Ngày chi + Nguồn chi đủ cả hai = đã trả (vào sổ thu chi bằng Còn lại phải chi). */
  @Column({ name: 'expense_date', type: 'date', nullable: true })
  expenseDate!: string | null;

  @Column({ name: 'cash_account', type: 'varchar', length: 20, nullable: true })
  cashAccount!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
