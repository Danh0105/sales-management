import {
    Entity,
    PrimaryGeneratedColumn,
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';

/** Một loại thiết bị trong kho (chỉ 1 kho duy nhất — không tách theo địa điểm). */
@Entity('warehouse_item')
export class WarehouseItem {
    @PrimaryGeneratedColumn()
    id!: number;

    /** Mã thiết bị tự sinh: TB-xxxx */
    @Column({ unique: true })
    code!: string;

    @Column({ length: 255 })
    name!: string;

    @Column({ length: 50, default: 'cái' })
    unit!: string;

    /** Số IMEI (nếu thiết bị là máy có IMEI riêng) — không bắt buộc. */
    @Column({ length: 50, nullable: true })
    imei?: string | null;

    /** Số lượng tồn hiện tại — chỉ được thay đổi qua WarehouseReceipt. */
    @Column({ type: 'int', default: 0 })
    quantity!: number;

    @Column({ type: 'text', nullable: true })
    note?: string | null;

    @Column()
    createdBy!: number;

    @ManyToOne(() => Employee)
    @JoinColumn({ name: 'createdBy' })
    creator?: Employee;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
