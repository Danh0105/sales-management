import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const MANUAL_ENTRY_KINDS = ['IN', 'OUT', 'TRANSFER'] as const;
/** IN = thu vào, OUT = chi ra, TRANSFER = chuyển nội bộ giữa hai tài khoản. */
export type ManualEntryKind = (typeof MANUAL_ENTRY_KINDS)[number];

/**
 * Bút toán thu/chi nhập tay trên Tổng hợp thu chi — khoản không đi qua phân
 * hệ nào khác (phí/lãi ngân hàng, rút/nộp tiền, chuyển nội bộ...). Xoá mềm để
 * giữ dấu vết; dòng đã xoá không vào sổ.
 */
@Entity('cash_manual_entries')
@Check('CHK_cash_manual_entries_kind', `"kind" IN ('IN','OUT','TRANSFER')`)
@Check('CHK_cash_manual_entries_amount', `"amount" > 0`)
@Check(
  'CHK_cash_manual_entries_counter',
  `("kind" = 'TRANSFER') = ("counter_account_code" IS NOT NULL) AND ("counter_account_code" IS NULL OR "counter_account_code" <> "account_code")`,
)
export class CashManualEntry {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_cash_manual_entries',
  })
  id!: number;

  @Column({ type: 'varchar', length: 10 })
  kind!: ManualEntryKind;

  @Column({ name: 'entry_date', type: 'date' })
  entryDate!: string;

  /** Thu: tài khoản nhận; Chi: tài khoản chi; Chuyển nội bộ: tài khoản chuyển đi. */
  @Column({ name: 'account_code', type: 'varchar', length: 20 })
  accountCode!: string;

  /** Chuyển nội bộ: tài khoản nhận. */
  @Column({
    name: 'counter_account_code',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  counterAccountCode!: string | null;

  /** Postgres trả chuỗi. */
  @Column({ type: 'decimal', precision: 18, scale: 2 })
  amount!: string;

  /** Trống thì báo cáo tự sinh PT-/PC-/CK-<id>. */
  @Column({ name: 'document_no', type: 'varchar', length: 50, nullable: true })
  documentNo!: string | null;

  @Column({ type: 'varchar', length: 500 })
  description!: string;

  @Column({
    name: 'partner_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  partnerName!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'created_by', type: 'int' })
  createdBy!: number;

  @Column({
    name: 'created_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  createdByName!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_by', type: 'int', nullable: true })
  updatedBy!: number | null;

  @Column({
    name: 'updated_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  updatedByName!: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @Column({ name: 'deleted_by', type: 'int', nullable: true })
  deletedBy!: number | null;

  @Column({
    name: 'deleted_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  deletedByName!: string | null;
}
