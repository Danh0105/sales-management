import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { OtherCashflowContract } from './other-cashflow-contract.entity';

/** Nhật ký thao tác của hợp đồng (gửi duyệt, duyệt, ghi nhận, huỷ…). */
@Entity('other_cashflow_events')
@Index('IDX_other_cashflow_events_contract', ['contractId'])
export class OtherCashflowEvent {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_other_cashflow_events' })
  id!: number;

  @Column({ name: 'contract_id', type: 'int' })
  contractId!: number;

  @ManyToOne(() => OtherCashflowContract, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'contract_id',
    foreignKeyConstraintName: 'FK_other_cashflow_events_contract',
  })
  contract?: OtherCashflowContract;

  @Column({ type: 'varchar', length: 40 })
  action!: string;

  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true })
  fromStatus!: string | null;

  @Column({ name: 'to_status', type: 'varchar', length: 20, nullable: true })
  toStatus!: string | null;

  @Column({ name: 'actor_id', type: 'int', nullable: true })
  actorId!: number | null;

  @Column({ name: 'actor_name', type: 'varchar', length: 255, nullable: true })
  actorName!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  changes!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
