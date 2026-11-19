import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';

import { ExpensePeriod } from '../../expense-periods/expense-period.entity';
import { numericTransformer } from '../../utils/numeric-transformer';
import { School } from '../../school/schools.entity';
import { Subject } from '../../subject/subject.entity';
import { SchoolTeacher } from '../../school-teacher-expense/school-teacher.entity';
import { Suggest } from './suggest.entity';
import type { CashflowSource } from '../cashflow-sources';

/**
 * Một trường trong đề xuất chi tháng: trường + năm học + môn + kỳ kế toán.
 * Một đề xuất chi tháng có thể gồm nhiều dòng. Dòng đầu tiên được chép lên
 * các cột `school_id`, `subject_id`, `expense_period_id` của `suggest` để
 * danh sách, bộ lọc và báo cáo cũ vẫn đọc được.
 */
@Entity('suggest_monthly_items')
@Index('idx_suggest_monthly_items_suggest', ['suggestId'])
@Index('idx_suggest_monthly_items_school', ['schoolId'])
export class SuggestMonthlyItem {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'int', name: 'suggest_id' })
    suggestId!: number;

    @ManyToOne(() => Suggest, (s) => s.monthlyItems, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'suggest_id' })
    suggest?: Suggest;

    @Column({ type: 'int', name: 'school_id', nullable: true })
    schoolId!: number | null;

    @ManyToOne(() => School, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_id' })
    school?: School | null;

    @Column({ type: 'varchar', name: 'school_year', length: 20, nullable: true })
    schoolYear!: string | null;

    @Column({ type: 'int', name: 'subject_id', nullable: true })
    subjectId!: number | null;

    @ManyToOne(() => Subject, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'subject_id' })
    subject?: Subject | null;

    @Column({ type: 'int', name: 'expense_period_id', nullable: true })
    expensePeriodId!: number | null;

    @ManyToOne(() => ExpensePeriod, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'expense_period_id' })
    expensePeriod?: ExpensePeriod | null;

    /**
     * Đề xuất Chi GV trường: khoản = lương một giáo viên của trường trong kỳ
     * (mọi môn). Các loại khác để trống (khoản = một môn của bảng thu chi).
     */
    @Column({ type: 'int', name: 'school_teacher_id', nullable: true })
    schoolTeacherId!: number | null;

    @ManyToOne(() => SchoolTeacher, { nullable: true, onDelete: 'SET NULL' })
    @JoinColumn({ name: 'school_teacher_id' })
    schoolTeacher?: SchoolTeacher | null;

    /** Còn phải chi của khoản lúc tạo/sửa đề xuất (để đối chiếu; lệnh chi tính lại lúc duyệt). */
    @Column({
        type: 'numeric',
        name: 'requested_amount',
        precision: 18,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    requestedAmount!: number | null;

    /**
     * Bảng nguồn của khoản ở "Đề xuất chi tháng" tích chọn (MANAGEMENT = Chi
     * Ban quản lí / bảng Chi Ngoài, SCHOOL_EXPENSE = Chi trường, SCHOOL_TEACHER
     * = Chi giáo viên). Trống = theo `suggest.cashflow_source`.
     */
    @Column({ type: 'varchar', name: 'cashflow_source', length: 20, nullable: true })
    cashflowSource!: CashflowSource | null;

    /** Thứ tự người tạo đã chọn. */
    @Column({ type: 'int', default: 0 })
    position!: number;

    /**
     * Còn chi của dòng này lúc Giám đốc duyệt (phần của nó trong lệnh chi).
     * Chỉ có khi lệnh chi do hệ thống lập từ bảng Chi Ngoài; Kế toán lập/sửa
     * lệnh chi thì xoá về null — khi đó không chi một phần theo trường được.
     */
    @Column({
        type: 'numeric',
        name: 'approved_amount',
        precision: 18,
        scale: 2,
        nullable: true,
        transformer: numericTransformer,
    })
    approvedAmount!: number | null;

    /** Kinh doanh xác nhận chi một phần: true đã chi, false không chi; null chưa xác nhận. */
    @Column({ type: 'boolean', nullable: true })
    spent!: boolean | null;

    /** Giám đốc không duyệt dòng này: không tính vào lệnh chi, không chi. */
    @Column({ type: 'boolean', default: false })
    excluded!: boolean;
}
