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
import { Employee } from '../../employee/employee.entity';
import { numericTransformer } from '../../utils/numeric-transformer';
import { Teacher } from './teacher.entity';

export enum TeacherLocationChangeStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

/** Lưu vết các lần giáo viên đề nghị đổi vị trí đã được ghi nhận. */
@Entity('teacher_location_changes')
@Index('IDX_teacher_location_changes_teacher_status', ['teacherId', 'status'])
export class TeacherLocationChange {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'teacher_id', type: 'int' })
  teacherId!: number;

  @ManyToOne(() => Teacher, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: Teacher;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 7,
    transformer: numericTransformer,
  })
  latitude!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 7,
    transformer: numericTransformer,
  })
  longitude!: number;

  @Column({
    name: 'previous_latitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  previousLatitude!: number | null;

  @Column({
    name: 'previous_longitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  previousLongitude!: number | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: TeacherLocationChangeStatus.PENDING,
  })
  status!: TeacherLocationChangeStatus;

  @Column({ name: 'reviewed_by', type: 'int', nullable: true })
  reviewedBy!: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewer?: Employee | null;

  @Column({ name: 'review_note', type: 'varchar', length: 500, nullable: true })
  reviewNote!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
