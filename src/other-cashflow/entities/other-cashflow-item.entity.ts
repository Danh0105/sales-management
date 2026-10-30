import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { bigintTransformer } from '../../financial-request/financial-money';
import { OtherCashflowContract } from './other-cashflow-contract.entity';

/**
 * Dòng hàng của đơn Thương mại. `quantity`/`unitPrice` là numeric chính xác
 * (đọc ra dạng chuỗi); `amount` = SL × đơn giá làm tròn tới đồng, do backend
 * tính (`lineAmount`). Chỉ thay được cả bộ khi đơn còn chờ duyệt / bị từ chối.
 */
@Entity('other_cashflow_items')
@Index('IDX_other_cashflow_items_contract', ['contractId'])
@Check(
  'CHK_other_cashflow_items_values',
  `"quantity" > 0 AND "unit_price" >= 0 AND "amount" >= 0`,
)
export class OtherCashflowItem {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_other_cashflow_items' })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_items_contract',
  })
  contract?: OtherCashflowContract;

  @Column({ name: 'line_no', type: 'int' })
  lineNo!: number;

  @Column({ name: 'item_code', type: 'varchar', length: 50 })
  itemCode!: string;

  @Column({ name: 'item_name', type: 'varchar', length: 255 })
  itemName!: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  unit!: string | null;

  @Column({ type: 'numeric', precision: 15, scale: 4 })
  quantity!: string;

  @Column({ name: 'unit_price', type: 'numeric', precision: 18, scale: 2 })
  unitPrice!: string;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;
}
