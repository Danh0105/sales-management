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

import { School } from '../school/schools.entity';

/**
 * Giáo viên của trường (không phải giáo viên Kido) nhận lương ở bảng Giáo viên
 * trường. Nhập một lần cho mỗi trường; ngừng dùng thì ẩn (`is_active`), không
 * xoá để các kỳ cũ vẫn hiện tên.
 */
@Entity('school_teachers')
@Index('IDX_school_teachers_school', ['schoolId'])
export class SchoolTeacher {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', name: 'school_id' })
  schoolId!: number;

  @ManyToOne(() => School, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_id' })
  school?: School;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'bank_account', type: 'varchar', length: 50, nullable: true })
  bankAccount!: string | null;

  @Column({ name: 'bank_name', type: 'varchar', length: 100, nullable: true })
  bankName!: string | null;

  /** Mã số thuế cá nhân. */
  @Column({ name: 'tax_code', type: 'varchar', length: 20, nullable: true })
  taxCode!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
