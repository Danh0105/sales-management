import { School } from '../school/schools.entity';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  Index,
  JoinColumn,
  ManyToOne,
  JoinTable,
  ManyToMany,
} from 'typeorm';
import { DailyReport } from '../daily-report/entities/daily-report.entity';
import { EmployeeRegion } from '../employee-region-school/entities/employee-region.entity';
import { Department } from '../department/department.entity';
import { EmployeeFace } from './employee-face.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { TrainingProgress } from '../trainings/training-progress.entity';

@Entity()
export class Employee {
  @PrimaryGeneratedColumn()
  id?: number;

  @Column({ nullable: true })
  name?: string;

  @Column({ nullable: true })
  password?: string;

  @Column({ unique: true, nullable: true })
  email?: string;

  @Column({ unique: true, nullable: true })
  phone?: string;

  /** Ảnh đại diện, đường dẫn tương đối `/uploads/avatars/...` — cùng kho với giáo viên. */
  @Column({ name: 'avatar_url', type: 'varchar', length: 500, nullable: true })
  avatarUrl?: string | null;

  @Column({ default: true })
  isActive?: boolean;

  @Column({ type: 'text', array: true, default: '{}' })
  roles: string[];

  @OneToMany(() => School, (school) => school.employee, { cascade: true })
  schools?: School[];

  @ManyToOne(() => Department, (department) => department.employees)
  @JoinColumn({ name: 'department_id' })
  department!: Department;

  /** ID ổn định của người dùng trong Zalo Mini App (`userInfo.id`). */
  @Index('IDX_employee_zalo_uid', { unique: true })
  @Column({ name: 'zalo_uid', type: 'varchar', nullable: true, unique: true })
  zaloUid?: string | null;

  /**
   * ID người dùng trên Zalo OA của công ty — đích để gửi cảnh báo qua Zalo.
   *
   * Không phải số điện thoại và cũng không phải ID tài khoản Zalo cá nhân: đây
   * là ID do OA cấp, chỉ có sau khi người đó quan tâm/nhắn tin cho OA. Trống thì
   * bỏ qua kênh Zalo, các kênh khác (trong app, push) vẫn chạy bình thường.
   */
  @Index('IDX_employee_zalo_user_id')
  @Column({
    name: 'zalo_user_id',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  zaloUserId?: string | null;

  @OneToMany(() => DailyReport, (report) => report.employee)
  dailyReports!: DailyReport[];

  @OneToMany(() => Notification, (noti) => noti.receiver)
  notifications!: Notification[];

  @OneToMany(() => EmployeeRegion, (er) => er.employee)
  employeeRegions!: EmployeeRegion[];

  @OneToMany(() => EmployeeFace, (face) => face.employee)
  faces!: EmployeeFace[];
  @OneToMany(() => TrainingProgress, (progress) => progress.employee)
  trainingProgresses!: TrainingProgress[];
}
