import { JwtAuthGuard } from './jwt-auth.guard';
import { DailyReportController } from '../daily-report/daily-report.controller';
import { PolicyController } from '../policy/policy.controller';
import { ProvinceController } from '../province/province.controller';
import { RegionController } from '../region/region.controller';
import { SchoolsController } from '../school/schools.controller';
import { StatisticsController } from '../statistics/statistics.controller';
import { SubjectCatalogsController } from '../subject-catalog/subject-catalog.controller';
import { SuggestController } from '../suggest/suggest.controller';
import { WardController } from '../ward/ward.controller';
import { WeeklyPlanController } from '../weekly-plan/weekly-plan.controller';

/** Các API nghiệp vụ từng mở không cần đăng nhập, kể cả ghi và xoá. */
describe('API nghiệp vụ bắt buộc đăng nhập', () => {
  it.each([
    DailyReportController,
    PolicyController,
    ProvinceController,
    RegionController,
    SchoolsController,
    StatisticsController,
    SubjectCatalogsController,
    SuggestController,
    WardController,
    WeeklyPlanController,
  ])('%p', (controller) => {
    expect(Reflect.getMetadata('__guards__', controller)).toContain(JwtAuthGuard);
  });
});
