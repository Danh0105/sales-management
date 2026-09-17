import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    ManyToOne,
    OneToOne,
    JoinColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { Suggest } from './suggest.entity';
import { PaymentMethod } from '../enums/expense-payment-method.enum';
import { FundSource } from '../enums/expense-fund-source.enum';

const numericTransformer = {
    to: (value?: number | null) => value,
    from: (value?: string | null) =>
        value === null || value === undefined ? value : Number(value),
};

/** Lệnh chi gắn với 1 đề xuất chi (Suggest type = EXPENSE_REQUEST) */
@Entity('suggest_payment_order')
export class SuggestPaymentOrder {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Số lệnh chi tự sinh: LC-YYYYMM-xxxx */
    @Column({ unique: true })
    code!: string;

    @Column({ unique: true })
    suggestId!: number;

    @OneToOne(() => Suggest, (s) => s.paymentOrder, {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'suggestId' })
    suggest?: Suggest;

    @Column({
        type: 'numeric',
        precision: 18,
        scale: 2,
        transformer: numericTransformer,
    })
    amount!: number;

    @Column({
        type: 'enum',
        enum: PaymentMethod,
    })
    paymentMethod!: PaymentMethod;

    /**
     * Nguồn tiền: tiền mặt sẵn có ở công ty hay tiền trong tài khoản ngân
     * hàng. Do Thủ quỹ chọn khi xác nhận đã xuất tiền (`confirmCashReleased`)
     * — còn `null` từ lúc lập lệnh chi tới lúc đó, tránh hiểu nhầm giá trị
     * mặc định là nguồn tiền đã được chọn thật.
     */
    @Column({
        type: 'enum',
        enum: FundSource,
        nullable: true,
    })
    fundSource!: FundSource | null;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    /** Kế toán công nợ lập lệnh */
    @Column()
    createdBy!: number;

    @ManyToOne(() => Employee)
    @JoinColumn({ name: 'createdBy' })
    creator?: Employee;

    @CreateDateColumn()
    createdAt!: Date;
}
