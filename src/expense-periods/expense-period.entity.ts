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
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { School } from '../school/schools.entity';


// Chặn tạo trùng kỳ (tháng/năm) trong cùng 1 trường ở tầng DB — kể cả khi
// nhiều request tạo chạy song song.
@Index('UQ_expense_period_school_month_year', ['school', 'month', 'year'], {
    unique: true,
})
@Entity('expense_periods')
export class ExpensePeriod {
    @PrimaryGeneratedColumn()
    id!: number;

    /**
     * Mỗi trường có danh sách kỳ chi phí RIÊNG — thêm/sửa/xoá ở trường này
     * không ảnh hưởng trường khác. Nullable để tương thích các kỳ cũ (tạo
     * trước khi có tính năng này, dùng chung cho mọi trường).
     */
    @ManyToOne(() => School, {
        nullable: true,
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'school_id' })
    school?: School | null;

    @Column()
    month!: number;

    @Column()
    year!: number;

    @Column({
        nullable: true,
    })
    name!: string;

    // 1 OPEN
    // 2 LOCKED
    @Column({
        default: 1,
    })
    status!: number;

    @OneToMany(
        () => SchoolExpense,
        (item) => item.period,
    )
    schoolExpenses!: SchoolExpense[];

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}