import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Danh mục tài khoản tiền (111 tiền mặt, 112 tiền gửi ngân hàng). `code` là
 * định danh ổn định — chứng từ lưu theo mã, không theo tên hiển thị.
 */
@Entity('cash_accounts')
export class CashAccount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 20, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** '111' | '112' */
  @Column({ type: 'varchar', length: 10 })
  groupCode!: string;

  @Column({ type: 'integer', default: 0 })
  sortOrder!: number;

  /** Ngừng sử dụng vẫn hiện trên báo cáo nếu còn số dư / phát sinh. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  /**
   * Số dư gốc đã đối chiếu, tại ĐẦU ngày `openingBalanceDate`. NULL = chưa
   * xác minh (báo cáo không coi là 0). Postgres trả chuỗi.
   */
  @Column({ type: 'decimal', precision: 18, scale: 2, nullable: true })
  openingBalance!: string | null;

  @Column({ type: 'date', nullable: true })
  openingBalanceDate!: string | null;

  @Column({ type: 'integer', nullable: true })
  openingBalanceUpdatedBy!: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  openingBalanceUpdatedByName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  openingBalanceUpdatedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
