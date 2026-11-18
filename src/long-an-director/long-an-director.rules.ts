import { LongAnScopeService } from './long-an-scope.service';

export type LongAnRuleInput = {
  params: Record<string, any>;
  query: Record<string, any>;
  body: Record<string, any>;
  userId: number;
};

type LongAnRule = (
  input: LongAnRuleInput,
  scope: LongAnScopeService,
) => boolean | Promise<boolean>;

const allow: LongAnRule = () => true;
const self: LongAnRule = ({ params, userId }) => Number(params.id) === userId;
const selfOrStaff: LongAnRule = ({ params, userId }, scope) =>
  Number(params.id) === userId || scope.employeeInScope(params.id);
const staffParam: LongAnRule = ({ params }, scope) =>
  scope.employeeInScope(params.employeeId);
const longAnOnlyStaffParam: LongAnRule = ({ params }, scope) =>
  scope.employeeIsLongAnOnly(params.employeeId);
const policyParam: LongAnRule = ({ params }, scope) => scope.policyInScope(params.id);
const subjectParam: LongAnRule = ({ params }, scope) => scope.subjectInScope(params.id);
const reportParam: LongAnRule = ({ params }, scope) => scope.reportInScope(params.id);
const planParam: LongAnRule = ({ params }, scope) => scope.weeklyPlanInScope(params.id);

/** Thông báo luôn lọc theo người nhận trong token, và theo phạm vi Long An ở service. */
export const LONG_AN_NOTIFICATION_CONTROLLERS = new Set([
  'NotificationController',
  'ExpenseNotificationController',
  'PlanNotificationController',
  'PolicyNotificationController',
  'ReportNotificationController',
  'SuggestNotificationController',
  'TeachingScheduleNotificationController',
]);

/**
 * Danh sách route Giám đốc Long An được gọi: `Controller.handler` → điều kiện.
 * Route không có ở đây bị chặn, nên module thêm sau này mặc định không vào được.
 * Danh sách (không có id trên URL) phải tự lọc theo tỉnh ở service tương ứng.
 */
export const LONG_AN_DIRECTOR_RULES: Record<string, LongAnRule> = {
  // Phiên đăng nhập + tài khoản của chính mình
  'AppController.getHello': allow,
  'AppVersionController.getVersion': allow,
  'AuthController.login': allow,
  'FaceController.loginByFace': allow,
  'EmployeeFcmTokenController.save': allow,
  'EmployeeFcmTokenController.remove': allow,
  'EmployeeController.changePassword': self,
  // Tự sửa hồ sơ: service không cho đổi roles, phòng ban, trạng thái, mật khẩu.
  'EmployeeController.update': self,

  // Nhân viên Long An
  'EmployeeController.findAll': allow,
  'EmployeeController.findSalesEmployees': allow,
  'EmployeeController.findOne': selfOrStaff,
  'EmployeeController.getEmployee': selfOrStaff,
  'ProvinceController.findAll': allow,
  'ProvinceController.getByEmployee': staffParam,
  'WardController.getWardsByEmployee': staffParam,

  // Chính sách: nhân viên → trường → môn → chính sách
  'SchoolsController.findByEmployee': staffParam,
  'SchoolsController.findOne': ({ params }, scope) => scope.schoolInScope(params.id),
  'SchoolsController.getByEmployeeWard': async ({ query }, scope) =>
    (await scope.employeeInScope(query.employeeId)) &&
    scope.wardInScope(query.wardId),
  'SubjectCatalogsController.findAll': allow,
  'SubjectCatalogsController.findOne': allow,
  'SubjectsController.findAll': ({ query }, scope) => scope.schoolInScope(query.schoolId),
  'SubjectsController.findBySchool': ({ query }, scope) => scope.schoolInScope(query.schoolId),
  'SubjectsController.findFinanceBySchool': ({ params }, scope) =>
    scope.schoolInScope(params.schoolId),
  'SubjectsController.findOne': subjectParam,
  'SubjectsController.create': ({ body }, scope) => scope.schoolInScope(body.schoolId),
  'SubjectsController.update': async ({ params, body }, scope) =>
    (await scope.subjectInScope(params.id)) &&
    (body.schoolId === undefined || scope.schoolInScope(body.schoolId)),
  'SubjectsController.remove': subjectParam,
  'PolicyController.findAllPaginated': allow,
  'PolicyController.findAllForAdmin': allow,
  'PolicyController.getFilterOptions': allow,
  'PolicyController.findOne': policyParam,
  'PolicyController.findBySubject': ({ params }, scope) => scope.subjectInScope(params.subjectId),
  'PolicyController.getByPolicy': ({ params }, scope) => scope.policyInScope(params.policyId),
  'PolicyController.findByHistory': ({ params }, scope) =>
    scope.policyHistoryInScope(params.historyId),
  'PolicyController.adminUpdateStatusNote': policyParam,
  'PolicyController.directorUpdatePolicy': policyParam,
  'PolicyContractMediaController.media': allow,

  // Báo cáo: tỉnh nằm trên chính báo cáo; nhân viên kiêm tỉnh vẫn hợp lệ.
  'DailyReportController.findAll': allow,
  'DailyReportController.getEmployeesReportedToday': allow,
  'DailyReportController.findByEmployee': staffParam,
  'DailyReportController.findByEmployeeGroupByWeek': staffParam,
  'DailyReportController.findOne': reportParam,
  'DailyReportController.findMessagesByReport': reportParam,
  'DailyReportController.createMessage': ({ body }, scope) =>
    scope.reportInScope(body.reportId),
  'WeeklyPlanController.getByEmployee': longAnOnlyStaffParam,
  'WeeklyPlanController.findOne': planParam,
  'WeeklyPlanController.getHistory': planParam,

  // Thống kê
  'PolicyController.getStats': allow,
  'PolicyController.getStatsBySchool': ({ query }, scope) => scope.schoolInScope(query.schoolId),
};
