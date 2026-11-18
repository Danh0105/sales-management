import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AppController } from '../app.controller';
import { AuthController } from '../auth/auth.controller';
import { FaceController } from '../auth/face.controller';
import { DailyReportController } from '../daily-report/daily-report.controller';
import { EmployeeController } from '../employee/employee.controller';
import { EmployeeFcmTokenController } from '../employee-fcm-token/employee-fcm-token.controller';
import { PolicyContractMediaController } from '../policy/policy-contract-media.controller';
import { PolicyController } from '../policy/policy.controller';
import { ProvinceController } from '../province/province.controller';
import { SchoolsController } from '../school/schools.controller';
import { SubjectCatalogsController } from '../subject-catalog/subject-catalog.controller';
import { SubjectsController } from '../subject/subject.controller';
import { AppVersionController } from '../version/version.controller';
import { WardController } from '../ward/ward.controller';
import { WeeklyPlanController } from '../weekly-plan/weekly-plan.controller';
import { LongAnDirectorGuard } from './long-an-director.guard';
import { LONG_AN_DIRECTOR_RULES } from './long-an-director.rules';

const scope = (inScope: boolean) => ({
  policyInScope: jest.fn().mockResolvedValue(inScope),
  subjectInScope: jest.fn().mockResolvedValue(inScope),
  schoolInScope: jest.fn().mockResolvedValue(inScope),
  employeeInScope: jest.fn().mockResolvedValue(inScope),
  employeeIsLongAnOnly: jest.fn().mockResolvedValue(inScope),
  reportInScope: jest.fn().mockResolvedValue(inScope),
  weeklyPlanInScope: jest.fn().mockResolvedValue(inScope),
});

function setup(roles: string[] | null, scopeService: any = scope(true)) {
  const jwt = {
    verifyAsync: jest.fn(async () => {
      if (!roles) throw new Error('bad token');
      return { sub: 91, name: 'Long An', roles };
    }),
  };
  const activityLog = { record: jest.fn() };
  const guard = new LongAnDirectorGuard(
    jwt as any,
    { get: () => 'secret' } as any,
    scopeService,
    activityLog as any,
  );
  const run = (
    controller: string,
    handler: string,
    req: Record<string, any> = {},
  ) =>
    guard.canActivate({
      getType: () => 'http',
      getClass: () => ({ name: controller }),
      getHandler: () => ({ name: handler }),
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/x',
          headers: { authorization: 'Bearer token' },
          params: {},
          query: {},
          body: {},
          ...req,
        }),
      }),
    } as unknown as ExecutionContext);
  return { run, activityLog, jwt };
}

describe('LongAnDirectorGuard', () => {
  it('không ảnh hưởng tài khoản khác', async () => {
    const { run, activityLog } = setup(['director']);
    await expect(run('SuggestController', 'findOne')).resolves.toBe(true);
    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('tài khoản kiêm director là giám đốc toàn hệ thống', async () => {
    const { run } = setup(['director_la', 'director']);
    await expect(run('PayrollController', 'findAll')).resolves.toBe(true);
  });

  it('không có token: để guard của route xử lý', async () => {
    const { run, jwt } = setup(['director_la']);
    await expect(run('SchoolsController', 'findAll', { headers: {} })).resolves.toBe(true);
    expect(jwt.verifyAsync).not.toHaveBeenCalled();
  });

  it('token sai: để JwtAuthGuard trả 401', async () => {
    const { run } = setup(null);
    await expect(run('SchoolsController', 'findAll')).resolves.toBe(true);
  });

  it.each([
    ['PayrollController', 'findAll'],
    ['FinancialRequestController', 'list'],
    ['RealExpensesController', 'findAll'],
    ['WarehouseController', 'findAll'],
    ['SchoolsController', 'findAll'],
    ['SchoolsController', 'search'],
    ['PolicyController', 'findAll'],
    ['SubjectMergeController', 'duplicates'],
    ['SuggestController', 'getStatsByPolicy'],
    ['EmployeeController', 'setDevRoles'],
    ['EmployeeController', 'assignRegion'],
    ['StatisticsController', 'getStats'],
  ])('chặn mặc định %s.%s và ghi nhật ký', async (controller, handler) => {
    const { run, activityLog } = setup(['director_la']);
    await expect(run(controller, handler)).rejects.toBeInstanceOf(ForbiddenException);
    expect(activityLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 91, success: false, statusCode: 403 }),
    );
  });

  it('dữ liệu thuộc Long An: cho qua và ghi nhật ký lần đọc', async () => {
    const { run, activityLog } = setup(['director_la']);
    await expect(run('PolicyController', 'findOne', { params: { id: '5' } })).resolves.toBe(true);
    expect(activityLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, resource: 'PolicyController' }),
    );
  });

  it('nhân viên kiêm tỉnh vẫn mở được danh sách báo cáo nhưng service phải lọc từng báo cáo', async () => {
    const scopeService = scope(true);
    const { run } = setup(['director_la'], scopeService);
    await expect(
      run('DailyReportController', 'findByEmployeeGroupByWeek', {
        params: { employeeId: '18' },
      }),
    ).resolves.toBe(true);
    expect(scopeService.employeeInScope).toHaveBeenCalledWith('18');
    expect(scopeService.employeeIsLongAnOnly).not.toHaveBeenCalled();
  });

  it.each([
    ['PolicyController', 'findOne', { params: { id: '5' } }],
    ['PolicyController', 'directorUpdatePolicy', { params: { id: '5' } }],
    ['SchoolsController', 'findOne', { params: { id: '5' } }],
    ['SubjectsController', 'create', { body: { schoolId: 5 } }],
    ['SubjectsController', 'findAll', { query: {} }],
    ['DailyReportController', 'findOne', { params: { id: '5' } }],
    ['DailyReportController', 'findByEmployeeGroupByWeek', { params: { employeeId: '18' } }],
    ['WeeklyPlanController', 'getHistory', { params: { id: '5' } }],
    ['EmployeeController', 'getEmployee', { params: { id: '18' } }],
  ])('dữ liệu ngoài Long An: chặn %s.%s', async (controller, handler, req) => {
    const { run } = setup(['director_la'], scope(false));
    await expect(run(controller, handler, req)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('chỉ đổi mật khẩu của chính mình, xem được hồ sơ của mình', async () => {
    const { run } = setup(['director_la'], scope(false));
    await expect(
      run('EmployeeController', 'changePassword', { method: 'PATCH', params: { id: '91' } }),
    ).resolves.toBe(true);
    await expect(
      run('EmployeeController', 'changePassword', { method: 'PATCH', params: { id: '18' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run('EmployeeController', 'getEmployee', { params: { id: '91' } })).resolves.toBe(true);
  });

  it('thông báo của chính mình: cho qua, không ghi nhật ký vì chuông gọi liên tục', async () => {
    const { run, activityLog } = setup(['director_la']);
    await expect(run('NotificationController', 'countUnread')).resolves.toBe(true);
    expect(activityLog.record).not.toHaveBeenCalled();
  });

  it('lỗi khi kiểm tra phạm vi thì chặn', async () => {
    const failing = scope(true);
    failing.policyInScope.mockRejectedValue(new Error('db down'));
    const { run } = setup(['director_la'], failing);
    await expect(run('PolicyController', 'findOne', { params: { id: '5' } })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('mọi quy tắc trỏ đúng handler có thật', () => {
    const controllers: Record<string, any> = {
      AppController,
      AppVersionController,
      AuthController,
      FaceController,
      DailyReportController,
      EmployeeController,
      EmployeeFcmTokenController,
      PolicyContractMediaController,
      PolicyController,
      ProvinceController,
      SchoolsController,
      SubjectCatalogsController,
      SubjectsController,
      WardController,
      WeeklyPlanController,
    };
    for (const key of Object.keys(LONG_AN_DIRECTOR_RULES)) {
      const [controller, handler] = key.split('.');
      expect(controllers[controller]).toBeDefined();
      expect(typeof controllers[controller].prototype[handler]).toBe('function');
    }
  });
});
