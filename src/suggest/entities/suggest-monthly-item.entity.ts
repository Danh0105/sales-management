import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';

import { ExpensePeriod } from '../../expense-periods/expense-period.entity';
import { School } from '../../school/schools.entity';
import { Subject } from '../../subject/subject.entity';
import { Suggest } from './suggest.entity';

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

    /** Thứ tự người tạo đã chọn. */
    @Column({ type: 'int', default: 0 })
    position!: number;
}
