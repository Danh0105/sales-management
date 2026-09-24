import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';

import { Employee } from '../../employee/employee.entity';
import { Suggest } from '../../suggest/entities/suggest.entity';

export enum WarehouseReceiptType {
  /** Phiếu nhập kho */
  IN = 'IN',
  /** Phiếu xuất kho */
  OUT = 'OUT',
}

/** Một dòng thiết bị trong phiếu nhập/xuất kho (snapshot tên tại thời điểm lập phiếu). */
export interface WarehouseReceiptItem {
  warehouseItemId: number;
  name: string;
  quantity: number;
  unit?: string | null;
  /** Đơn giá mua — chỉ có ở phiếu nhập của đề xuất thiết bị mới. */
  unitPrice?: number | null;
}

/** Phiếu nhập/xuất kho — nguồn duy nhất làm thay đổi tồn kho của `WarehouseItem`. */
@Entity('warehouse_receipt')
export class WarehouseReceipt {
  @PrimaryGeneratedColumn()
  id!: number;

  /** Số phiếu tự sinh: PNK-YYYYMM-xxxx (nhập) hoặc PXK-YYYYMM-xxxx (xuất) */
  @Column({ unique: true })
  code!: string;

  @Column({ type: 'enum', enum: WarehouseReceiptType })
  type!: WarehouseReceiptType;

  @Column({ type: 'jsonb' })
  items!: WarehouseReceiptItem[];

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  /** Đề xuất liên quan (lệnh xuất kho của đề xuất thiết bị, hoặc phiếu nhập của đề xuất thiết bị mới). */
  @Column({ type: 'int', nullable: true })
  relatedSuggestId?: number | null;

  @ManyToOne(() => Suggest, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'relatedSuggestId' })
  relatedSuggest?: Suggest | null;

  @Column()
  createdBy!: number;

  @ManyToOne(() => Employee)
  @JoinColumn({ name: 'createdBy' })
  creator?: Employee;

  @CreateDateColumn()
  createdAt!: Date;
}
