import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Teacher } from './teacher.entity';
import { School } from '../../school/schools.entity';
import { SchoolLocation } from '../../school-location/entities/school-location.entity';
import { SchoolClass } from './school-class.entity';
import { Subject } from '../../subject/subject.entity';
import { Employee } from '../../employee/employee.entity';
import { StoredLessonImage } from '../lesson-image.type';
import { TeachingSchedule } from './teaching-schedule.entity';
import { AssignmentStatus, ConfirmationStatus, SessionStatus } from '../teaching.enum';
import { numericTransformer } from '../../utils/numeric-transformer';

export interface AttendanceOtherCost {
  name: string;
  amount: number;
  note?: string | null;
}

/**
 * Một buổi dạy cụ thể. Vừa là lịch dạy (ngày/giờ/ai/ở đâu), vừa là phiếu chấm công
 * (`status` + `checkedBy` + `checkedAt`) — gắn liền nhau nên số liệu luôn khớp.
 *
 * teacher/school/subject được lưu trực tiếp (không chỉ qua schedule) để:
 * - tạo được buổi lẻ / buổi dạy bù không thuộc mẫu lặp nào,
 * - đổi giáo viên dạy thay cho một buổi mà không đụng vào mẫu.
 */
@Entity('teaching_sessions')
@Index('IDX_teaching_sessions_date', ['date'])
@Index('IDX_teaching_sessions_teacher_date', ['teacherId', 'date'])
@Index('IDX_teaching_sessions_class_date', ['classId', 'date'])
@Index('IDX_teaching_sessions_status_date', ['status', 'date'])
// Một mẫu lặp chỉ sinh đúng 1 buổi cho mỗi ngày -> sinh lại nhiều lần không nhân đôi.
@Index('UQ_teaching_sessions_schedule_date', ['scheduleId', 'date'], {
  unique: true,
  where: '"schedule_id" IS NOT NULL',
})
export class TeachingSession {
  @PrimaryGeneratedColumn()
  id!: number;

  /** null = buổi lẻ hoặc buổi dạy bù, không sinh từ mẫu lặp. */
  @Column({ name: 'schedule_id', type: 'int', nullable: true })
  scheduleId?: number | null;

  @ManyToOne(() => TeachingSchedule, (schedule) => schedule.sessions, {
    nullable: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'schedule_id' })
  schedule?: TeachingSchedule | null;

  @Column({ name: 'teacher_id', type: 'int', nullable: true })
  teacherId?: number | null;

  @ManyToOne(() => Teacher, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'teacher_id' })
  teacher?: Teacher | null;

  @Column({ name: 'school_id' })
  @Index('IDX_teaching_sessions_school_id')
  schoolId!: number;

  @ManyToOne(() => School, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'school_id' })
  school!: School;

  @Column({ name: 'school_location_id', type: 'int', nullable: true })
  @Index('IDX_teaching_sessions_school_location_id')
  schoolLocationId?: number | null;

  @ManyToOne(() => SchoolLocation, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'school_location_id' })
  schoolLocation?: SchoolLocation | null;

  /** Lớp được dạy buổi này; null với buổi cũ xếp theo trường. */
  @Column({ name: 'class_id', type: 'int', nullable: true })
  @Index('IDX_teaching_sessions_class_id')
  classId?: number | null;

  @ManyToOne(() => SchoolClass, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'class_id' })
  class?: SchoolClass | null;

  @Column({ name: 'subject_id' })
  @Index('IDX_teaching_sessions_subject_id')
  subjectId!: number;

  @ManyToOne(() => Subject, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subject_id' })
  subject!: Subject;

  @Column({ type: 'date' })
  date!: string;

  @Column({ name: 'start_time', type: 'time' })
  startTime!: string;

  @Column({ name: 'end_time', type: 'time' })
  endTime!: string;

  @Column({ type: 'int', nullable: true })
  periods?: number | null;

  /**
   * Đơn giá mỗi tiết **chốt tại thời điểm tạo buổi**, lấy từ `subject.ratePerPeriod`
   * (Nhân sự khai theo môn học, không còn khai theo giáo viên/mẫu lịch).
   *
   * Chốt vào từng buổi thay vì tra ngược lúc tính lương: đơn giá thay đổi
   * theo thời gian, nếu tra ngược thì sửa đơn giá hôm nay sẽ làm lệch cả bảng
   * công đã chốt của các tháng trước.
   */
  @Column({
    name: 'rate_per_period',
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  ratePerPeriod?: number | null;

  /**
   * Khoảng cách (km) từ vị trí giáo viên tới trường — chỉ tính khi giáo viên
   * là giáo viên công ty (`giaovien_congty`) và đã có vị trí, chốt tại thời
   * điểm tạo buổi (giống `ratePerPeriod`). `null` = giáo viên cộng tác viên,
   * chưa có vị trí, hoặc buổi chưa gán giáo viên.
   */
  @Column({
    name: 'distance_to_school_km',
    type: 'decimal',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  distanceToSchoolKm?: number | null;

  /**
   * Phụ cấp xăng đã chốt theo bậc khoảng cách (`FuelAllowanceTier`) tại thời
   * điểm tạo buổi — chỉ có ở giáo viên công ty. Giáo viên công ty **không**
   * nhận tiền theo `ratePerPeriod`; khoản này thay thế, tính theo MỖI LẦN
   * đến trường (1 block tiết liên tiếp cùng trường), không phải theo từng
   * tiết — xem cách gộp lại 1 lần/block ở `attendanceSummary()`.
   */
  @Column({
    name: 'gas_allowance',
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: numericTransformer,
  })
  gasAllowance?: number | null;

  @Column({
    name: 'assignment_status',
    type: 'enum',
    enum: AssignmentStatus,
    default: AssignmentStatus.ASSIGNED,
  })
  assignmentStatus!: AssignmentStatus;

  /** Gợi ý tự động gần trường nhất; không phải phân công chính thức. */
  @Column({ name: 'recommended_teacher_id', type: 'int', nullable: true })
  recommendedTeacherId?: number | null;

  @ManyToOne(() => Teacher, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'recommended_teacher_id' })
  recommendedTeacher?: Teacher | null;

  @Column({
    type: 'enum',
    enum: SessionStatus,
    default: SessionStatus.SCHEDULED,
  })
  status!: SessionStatus;

  /** Buổi dạy bù cho một buổi vắng/huỷ trước đó. */
  @Column({ name: 'is_makeup', type: 'boolean', default: false })
  isMakeup!: boolean;

  @Column({ name: 'makeup_for_session_id', type: 'int', nullable: true })
  makeupForSessionId?: number | null;

  @ManyToOne(() => TeachingSession, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'makeup_for_session_id' })
  makeupForSession?: TeachingSession | null;

  @Column({ name: 'attendance_note', type: 'text', nullable: true })
  attendanceNote?: string | null;

  /** Xăng xe, phụ cấp và các khoản phát sinh được duyệt khi chấm công. */
  @Column({ name: 'other_costs', type: 'jsonb', default: () => "'[]'::jsonb" })
  otherCosts!: AttendanceOtherCost[];

  /** Tổng tiền denormalize để tổng hợp công không phải bung JSON cho mọi dòng. */
  @Column({
    name: 'other_costs_total',
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: numericTransformer,
  })
  otherCostsTotal!: number;

  /** Nhân sự đã chấm buổi này. */
  @Column({ name: 'checked_by_id', type: 'int', nullable: true })
  checkedById?: number | null;

  @ManyToOne(() => Employee, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'checked_by_id' })
  checkedBy?: Employee | null;

  @Column({ name: 'checked_at', type: 'timestamp', nullable: true })
  checkedAt?: Date | null;

  @Column({ name: 'checkin_at', type: 'timestamp', nullable: true })
  checkinAt?: Date | null;

  @Column({
    name: 'checkin_latitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  checkinLatitude?: number | null;

  @Column({
    name: 'checkin_longitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  checkinLongitude?: number | null;

  @Column({ name: 'checkin_accuracy', type: 'int', nullable: true })
  checkinAccuracy?: number | null;

  @Column({ name: 'checkin_distance', type: 'int', nullable: true })
  checkinDistance?: number | null;

  @Column({
    name: 'checkin_out_of_range',
    type: 'boolean',
    nullable: true,
    default: false,
  })
  checkinOutOfRange?: boolean | null;

  /** Ảnh giáo viên chụp tại thời điểm check-in. */
  @Column({ name: 'checkin_images', type: 'jsonb', nullable: true })
  checkinImages?: StoredLessonImage[] | null;

  /**
   * Thời điểm đã bắn báo động "sắp tới giờ mà chưa check-in".
   *
   * Cột này là khoá chống gửi trùng: job chạy mỗi phút, không có dấu thì cùng
   * một buổi sẽ bắn lại ở mọi lần chạy trong cửa sổ báo trước.
   */
  @Column({ name: 'checkin_alert_at', type: 'timestamp', nullable: true })
  checkinAlertAt?: Date | null;

  /**
   * Giáo viên phải xác nhận/từ chối buổi này. Chỉ có ý nghĩa khi đã có
   * `teacherId` và `assignmentStatus = ASSIGNED`; buổi sinh từ mẫu lặp kế
   * thừa trạng thái của `TeachingSchedule` tại thời điểm sinh.
   */
  @Column({
    name: 'confirmation_status',
    type: 'enum',
    enum: ConfirmationStatus,
    default: ConfirmationStatus.PENDING,
  })
  confirmationStatus!: ConfirmationStatus;

  @Column({ name: 'confirmed_at', type: 'timestamp', nullable: true })
  confirmedAt?: Date | null;

  /** Lý do từ chối — bắt buộc khi giáo viên từ chối. */
  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null;

  /**
   * Thời điểm đã bắn cảnh báo "còn chưa xác nhận, sắp tới buổi dạy" (trong
   * vòng 1 ngày). Khoá chống gửi trùng — job quét định kỳ, không có dấu thì
   * cùng một buổi sẽ bắn lại ở mọi lần chạy trong cửa sổ 24h.
   */
  @Column({ name: 'confirmation_alert_at', type: 'timestamp', nullable: true })
  confirmationAlertAt?: Date | null;

  /**
   * Giáo viên xin rút khỏi buổi đã phân công vì có việc đột xuất — khác với
   * REJECTED ở `confirmationStatus` (từ chối trước khi nhận việc, chưa từng
   * được coi là của mình). `teacherId` bị gỡ ngay khi từ chối nên phải lưu
   * lại người vừa từ chối ở đây để Nhân sự tra lịch sử và không gửi lại
   * thông báo phân công cho đúng người vừa từ chối.
   */
  @Column({ name: 'declined_at', type: 'timestamp', nullable: true })
  declinedAt?: Date | null;

  /** Lý do bắt buộc do giáo viên nhập. */
  @Column({ name: 'decline_reason', type: 'text', nullable: true })
  declineReason?: string | null;

  @Column({ name: 'declined_teacher_id', type: 'int', nullable: true })
  declinedTeacherId?: number | null;

  @ManyToOne(() => Teacher, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'declined_teacher_id' })
  declinedTeacher?: Teacher | null;

  @Column({ name: 'checkout_at', type: 'timestamp', nullable: true })
  checkoutAt?: Date | null;

  @Column({
    name: 'checkout_latitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  checkoutLatitude?: number | null;

  @Column({
    name: 'checkout_longitude',
    type: 'decimal',
    precision: 10,
    scale: 7,
    nullable: true,
    transformer: numericTransformer,
  })
  checkoutLongitude?: number | null;

  @Column({ name: 'checkout_accuracy', type: 'int', nullable: true })
  checkoutAccuracy?: number | null;

  @Column({ name: 'checkout_distance', type: 'int', nullable: true })
  checkoutDistance?: number | null;

  @Column({
    name: 'checkout_out_of_range',
    type: 'boolean',
    nullable: true,
    default: false,
  })
  checkoutOutOfRange?: boolean | null;

  /**
   * `true` = checkout của tiết này đến từ việc check-out tiết CUỐI cùng block
   * (tiết đầu/giữa được "ăn theo" toạ độ/thời điểm của tiết cuối), không phải
   * do giáo viên tự bấm check-out cho đúng tiết này. `false`/`null` = giáo
   * viên tự check-out tiết này (kể cả khi đó là tiết đầu/giữa của block —
   * dùng cho trường hợp muốn báo giảng ngay sau khi dạy xong tiết đó).
   */
  @Column({
    name: 'checkout_via_adjacent',
    type: 'boolean',
    nullable: true,
    default: false,
  })
  checkoutViaAdjacent?: boolean | null;

  @Column({ name: 'lesson_name', type: 'varchar', length: 255, nullable: true })
  lessonName?: string | null;

  @Column({ name: 'lesson_evaluation', type: 'text', nullable: true })
  lessonEvaluation?: string | null;

  /** Sĩ số thực tế giáo viên ghi khi báo giảng. */
  @Column({ name: 'actual_student_count', type: 'int', nullable: true })
  actualStudentCount?: number | null;

  /** Tách khỏi checkoutAt: chấm công và báo giảng là hai thao tác độc lập. */
  @Column({ name: 'lesson_submitted_at', type: 'timestamp', nullable: true })
  lessonSubmittedAt?: Date | null;

  /** Khoá chống gửi lặp cảnh báo báo giảng lúc 19:00. */
  @Column({ name: 'lesson_report_alert_at', type: 'timestamp', nullable: true })
  lessonReportAlertAt?: Date | null;

  /** Danh sách ảnh/video minh chứng — giữ tên cột cũ để tương thích dữ liệu. */
  @Column({ name: 'lesson_images', type: 'jsonb', nullable: true })
  lessonImages?: StoredLessonImage[] | null;

  @Column({ type: 'text', nullable: true })
  note?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
