export enum NotificationType {
  POLICY = 'POLICY',
  SUGGEST = 'SUGGEST',
  REPORT = 'REPORT',
  SYSTEM = 'SYSTEM',
  WEEKLY_PLAN = 'WEEKLY_PLAN',
  EXPENSE_REQUEST = 'EXPENSE_REQUEST',
  /** Nhân sự gửi lịch dạy cho giáo viên. */
  TEACHING_SCHEDULE = 'TEACHING_SCHEDULE',
  /** Sắp tới giờ dạy mà giáo viên chưa check-in — báo cho Giáo vụ & Nhân sự. */
  TEACHING_CHECKIN_ALERT = 'TEACHING_CHECKIN_ALERT',
  /** Giáo viên vừa được giao lịch/buổi mới, cần xác nhận hoặc từ chối. */
  TEACHING_SCHEDULE_CONFIRM_REQUEST = 'TEACHING_SCHEDULE_CONFIRM_REQUEST',
  /** Giáo viên đã xác nhận/từ chối — báo cho Giáo vụ, Nhân sự và chính giáo viên. */
  TEACHING_SCHEDULE_CONFIRM_RESULT = 'TEACHING_SCHEDULE_CONFIRM_RESULT',
  /** Còn dưới 1 ngày mà chưa xác nhận/từ chối — nhắc giáo viên, báo Giáo vụ & Nhân sự. */
  TEACHING_SCHEDULE_CONFIRM_ALERT = 'TEACHING_SCHEDULE_CONFIRM_ALERT',
  /** 19:00 ngày dạy mà tiết đã chấm công vẫn chưa báo giảng. */
  TEACHING_LESSON_REPORT_ALERT = 'TEACHING_LESSON_REPORT_ALERT',
  /** Giáo viên từ chối buổi đã phân công (việc đột xuất) — báo Giáo vụ, Nhân sự tìm người thay. */
  TEACHING_REPLACEMENT_REQUEST = 'TEACHING_REPLACEMENT_REQUEST',
  /** Giáo viên đề nghị đổi vị trí — báo đồng thời cho Giáo vụ và Nhân sự duyệt. */
  TEACHER_LOCATION_CHANGE_REQUEST = 'TEACHER_LOCATION_CHANGE_REQUEST',
  /** Giáo vụ/Nhân sự đã duyệt hoặc từ chối yêu cầu đổi vị trí — báo lại cho giáo viên. */
  TEACHER_LOCATION_CHANGE_RESULT = 'TEACHER_LOCATION_CHANGE_RESULT',
  /** Giáo vụ đề nghị mở tài khoản giáo viên — báo cho Nhân sự duyệt. */
  TEACHER_ACCOUNT_REQUEST = 'TEACHER_ACCOUNT_REQUEST',
  /** Nhân sự đã duyệt/từ chối đề nghị mở tài khoản — báo lại cho Giáo vụ đã gửi. */
  TEACHER_ACCOUNT_RESULT = 'TEACHER_ACCOUNT_RESULT',
}
