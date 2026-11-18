import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { bigintTransformer } from '../financial-money';

/** Danh mục chi phí (đi lại, lưu trú, ăn uống...) kèm định mức mỗi dòng nếu có. */
@Entity('financial_expense_categories')
@Unique('UQ_financial_expense_categories_code', ['code'])
export class FinancialExpenseCategory {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_financial_expense_categories',
  })
  id!: number;

  @Column({ type: 'varchar', length: 50 })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Định mức tối đa cho một dòng chi phí; NULL = không giới hạn. */
  @Column({
    name: 'limit_amount',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  limitAmount!: number | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
