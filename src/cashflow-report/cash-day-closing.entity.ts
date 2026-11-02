import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DayClosingStatus = 'CLOSED' | 'REOPENED';
/** MANUAL = bấm "End of Day"; AUTO = cron tự chốt sau 0h. */
export type DayClosingMode = 'MANUAL' | 'AUTO';

/** Số dư một tài khoản trong ngày chốt (tiền dạng chuỗi "1234.00"; null = chưa xác minh). */
export interface DayClosingBalance {
  code: string;
  name: string;
  groupCode: string;
  opening: string | null;
  receipts: string;
  payments: string;
  closing: string | null;
  lineCount: number;
}

/**
 * Chốt quỹ ngày trên Tổng hợp thu chi: mỗi ngày đã chốt một dòng CLOSED kèm ảnh
 * số dư từng tài khoản. Mọi ngày ≤ ngày CLOSED gần nhất bị khoá ở báo cáo.
 * Mở lại chỉ đổi dòng thành REOPENED (giữ lịch sử); chốt lại tạo dòng mới.
 */
@Entity('cash_day_closings')
@Check('CHK_cash_day_closings_status', `"status" IN ('CLOSED','REOPENED')`)
@Check('CHK_cash_day_closings_mode', `"mode" IN ('MANUAL','AUTO')`)
@Index('UQ_cash_day_closings_closed_date', ['closingDate'], {
  unique: true,
  where: `"status" = 'CLOSED'`,
})
export class CashDayClosing {
  @PrimaryGeneratedColumn({ primaryKeyConstraintName: 'PK_cash_day_closings' })
  id!: number;

  @Column({ name: 'closing_date', type: 'date' })
  closingDate!: string;

  @Column({ type: 'varchar', length: 10, default: 'CLOSED' })
  status!: DayClosingStatus;

  @Column({ type: 'varchar', length: 10 })
  mode!: DayClosingMode;

  @Column({ type: 'jsonb' })
  balances!: DayClosingBalance[];

  @Column({ name: 'line_count', type: 'int' })
  lineCount!: number;

  @Column({ name: 'closed_by', type: 'int', nullable: true })
  closedBy!: number | null;

  @Column({
    name: 'closed_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  closedByName!: string | null;

  @CreateDateColumn({ name: 'closed_at', type: 'timestamptz' })
  closedAt!: Date;

  @Column({ name: 'reopened_by', type: 'int', nullable: true })
  reopenedBy!: number | null;

  @Column({
    name: 'reopened_by_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  reopenedByName!: string | null;

  @Column({ name: 'reopened_at', type: 'timestamptz', nullable: true })
  reopenedAt!: Date | null;

  @Column({ name: 'reopen_reason', type: 'text', nullable: true })
  reopenReason!: string | null;
}
