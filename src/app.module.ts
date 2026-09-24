import { Module, Version } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { EmployeeModule } from './employee/employee.module';
import { SchoolsModule } from './school/schools.module';
import { SubjectsModule } from './subject/subject.module';
import { SubjectCatalogsModule } from './subject-catalog/subject-catalog.module';
import { NotifyModule } from './notify-zalo/notify.module';
import { ConfigModule } from '@nestjs/config';
import { PolicyModule } from './policy/policy.module';
import { DepartmentModule } from './department/department.module';
import { RegionModule } from './region/region.module';
import { AppVersionModule } from './version/version.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { DailyReportModule } from './daily-report/daily-report.module';
import { NotificationModule } from './notifications/notification.module';
import { EmployeeRegionSchoolModule } from './employee-region-school/employee-region.module';
import { WeeklyPlanModule } from './weekly-plan/weekly-plan.module';
import { StatisticsModule } from './statistics/statistics.module';
import { SuggestModule } from './suggest/suggest.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ProvinceModule } from './province/province.module';
import { WardModule } from './ward/ward.module';
import { EmployeeFcmTokenModule } from './employee-fcm-token/employee-fcm-token.module';
import { DisplayModule } from './display/display.module';
import { TrainingModule } from './trainings/training.module';
import { CashPolicyItemsModule } from './cash-policy-item/cash-policy-items.module';
import { ExpenseItemsModule } from './expense-item/expense-items.module';
import { ExpensePeriodsModule } from './expense-periods/expense-periods.module';
import { SchoolExpensesModule } from './school-expenses/real-expenses.module';
import { RevenueItemsModule } from './revenue-item/revenue-items.module';
import { SchoolExpenseItemsModule } from './school-expense-item/school-expense-items.module';
import { ManagementExpenseItemsModule } from './management-expense-item/management-expense-items.module';
import { AnnualPolicyModule } from './annual-policy/annual-policy.module';
import { PolicyYearModule } from './policy-year/policy-year.module';
import { TeachingModule } from './teaching/teaching.module';
import { ScheduleModule } from '@nestjs/schedule';
import { ZaloOaModule } from './zalo-oa/zalo-oa.module';
import { ZaloLocationModule } from './zalo-location/zalo-location.module';
import { TimetableImportModule } from './timetable-import/timetable-import.module';
import { VirtualTryOnModule } from './virtual-tryon/virtual-tryon.module';
import { SchoolLocationModule } from './school-location/school-location.module';
import { ActivityLogModule } from './activity-log/activity-log.module';
import { WarehouseModule } from './warehouse/warehouse.module';
import { PayrollModule } from './payroll/payroll.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads', 'apk'),
      serveRoot: '/apk',
    }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: 'postgres',
      database: 'sales_db',
      autoLoadEntities: true,
      synchronize: true,
    }),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ActivityLogModule,
    EmployeeModule,
    AuthModule,
    SchoolsModule,
    SubjectsModule,
    SubjectCatalogsModule,
    NotifyModule,
    PolicyModule,
    EmployeeRegionSchoolModule,
    RegionModule,
    DepartmentModule,
    AppVersionModule,
    DailyReportModule,
    NotificationModule,
    WeeklyPlanModule,
    StatisticsModule,
    SuggestModule,
    ProvinceModule,
    WardModule,
    EmployeeFcmTokenModule,
    DisplayModule,
    TrainingModule,
    SchoolExpensesModule,
    ExpenseItemsModule,
    CashPolicyItemsModule,
    ExpensePeriodsModule,
    RevenueItemsModule,
    SchoolExpenseItemsModule,
    ManagementExpenseItemsModule,
    AnnualPolicyModule,
    PolicyYearModule,
    TeachingModule,
    TimetableImportModule,
    VirtualTryOnModule,
    ZaloLocationModule,
    ZaloOaModule,
    SchoolLocationModule,
    WarehouseModule,
    PayrollModule,
  ],
})
export class AppModule {}
