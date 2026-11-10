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
import { FinancialRequest } from './financial-request.entity';

/**
 * Nhà cung cấp nhận tiền của một phiếu Thanh toán chi phí — thủ quỹ chuyển
 * khoản thẳng cho NCC thay vì cho người đề nghị. Số tiền mỗi NCC = tổng các
 * dòng chi tiết gán cho NCC đó (không lưu riêng, nên không lệch được).
 */
@Entity('financial_request_suppliers')
@Index('IDX_financial_request_suppliers_request', ['requestId'])
export class FinancialRequestSupplier {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_request_suppliers',
  })
  id!: number;

  @Column({ name: 'request_id', type: 'int' })
  requestId!: number;

  @ManyToOne(() => FinancialRequest, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'request_id',
    foreignKeyConstraintName: 'FK_financial_request_suppliers_request',
  })
  request?: FinancialRequest;

  @Column({ name: 'line_no', type: 'smallint' })
  lineNo!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({
    name: 'bank_account_holder',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  bankAccountHolder!: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 255, nullable: true })
  bankName!: string | null;

  @Column({
    name: 'bank_account_number',
    type: 'varchar',
    length: 50,
    nullable: true,
  })
  bankAccountNumber!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
