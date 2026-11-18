import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { MovementStatus, PaymentMethod } from '../financial-request.constants';
import { bigintTransformer } from '../financial-money';
import { FinancialRequest } from './financial-request.entity';

/**
 * Phiếu thu: nhân viên hoàn trả tiền thừa sau hoàn ứng.
 * Không sửa/xoá — sai thì huỷ (VOIDED, kèm lý do) rồi ghi lại.
 * `idempotencyKey` duy nhất chống ghi trùng khi bấm/gửi lặp.
 */
@Entity('financial_refunds')
@Unique('UQ_financial_refunds_idempotency', ['idempotencyKey'])
@Index('IDX_financial_refunds_request', ['requestId'])
@Check('CHK_financial_refunds_amount', `"amount" > 0`)
@Check('CHK_financial_refunds_status', `"status" IN ('RECORDED','VOIDED')`)
@Check('CHK_financial_refunds_method', `"method" IN ('BANK_TRANSFER','CASH')`)
export class FinancialRefund {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_financial_refunds' })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_refunds_request',
  })
  request?: FinancialRequest;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount!: number;

  @Column({ name: 'received_at', type: 'date' })
  receivedAt!: string;

  @Column({ type: 'varchar', length: 20 })
  method!: PaymentMethod;

  /** Mã tài khoản tiền (bảng cash_accounts). */
  @Column({
    name: 'cash_account_code',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  cashAccountCode!: string | null;

  /** Mã giao dịch ngân hàng / số phiếu. */
  @Column({
    name: 'transaction_ref',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  transactionRef!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 100 })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 20, default: MovementStatus.RECORDED })
  status!: MovementStatus;

  @Column({ name: 'recorded_by_id', type: 'int' })
  recordedById!: number;

  @Column({
    name: 'recorded_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  recordedByName!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'voided_at', type: 'timestamptz', nullable: true })
  voidedAt!: Date | null;

  @Column({ name: 'voided_by_id', type: 'int', nullable: true })
  voidedById!: number | null;

  @Column({
    name: 'voided_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  voidedByName!: string | null;

  @Column({ name: 'void_reason', type: 'text', nullable: true })
  voidReason!: string | null;
}
