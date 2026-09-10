import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Teacher } from './entities/teacher.entity';
import { SchoolClass } from './entities/school-class.entity';
import { TeachingSchedule } from './entities/teaching-schedule.entity';
import { TeachingSession } from './entities/teaching-session.entity';
import { Employee } from '../employee/employee.entity';
import { School } from '../school/schools.entity';
import { SchoolLocation } from '../school-location/entities/school-location.entity';
import { Subject } from '../subject/subject.entity';
import { SubjectCatalog } from '../subject-catalog/subject-catalog.entity';
import { TeachingApplication } from './entities/teaching-application.entity';
import { TeachingScheduleNotificationLog } from './entities/teaching-schedule-notification-log.entity';
import { TeacherLocationChange } from './entities/teacher-location-change.entity';
import { TeacherAccountRequest } from './entities/teacher-account-request.entity';
import { FuelAllowanceTier } from './entities/fuel-allowance-tier.entity';
import { Ward } from '../ward/ward.entity';
import { NotificationModule } from '../notifications/notification.module';
import { SchoolsModule } from '../school/schools.module';
import { SchoolLocationModule } from '../school-location/school-location.module';
import { FcmModule } from '../fcm/fcm.module';
import { EmployeeFcmTokenModule } from '../employee-fcm-token/employee-fcm-token.module';
// Kênh Zalo OA của báo động "giáo viên chưa check-in".
import { NotifyModule } from '../notify-zalo/notify.module';

import { SchoolClassService } from './school-class.service';
import { SubjectResolverService } from './subject-resolver.service';
import { TeachingBulkService } from './teaching-bulk.service';
import { TeacherService } from './teacher.service';
import { TeacherMatchingService } from './teacher-matching.service';
import { AvatarStorageService } from './avatar-storage.service';
import { LessonImageStorageService } from './lesson-image-storage.service';
import { LessonImageLibraryService } from './lesson-image-library.service';
import { LessonImageEntity } from './entities/lesson-image.entity';
import { TeachingScheduleService } from './teaching-schedule.service';
import { TeachingSessionService } from './teaching-session.service';
import { FuelAllowanceTierService } from './fuel-allowance-tier.service';

import { SchoolClassController } from './school-class.controller';
import { TeacherController } from './teacher.controller';
import { TeachingScheduleController } from './teaching-schedule.controller';
import { TeachingSessionController } from './teaching-session.controller';
import { FuelAllowanceTierController } from './fuel-allowance-tier.controller';

@Module({
  imports: [
    NotificationModule,
    // resolveGoogleMaps() để giải toạ độ giáo viên từ link Maps.
    SchoolsModule,
    SchoolLocationModule,
    FcmModule,
    EmployeeFcmTokenModule,
    NotifyModule,
    TypeOrmModule.forFeature([
      Teacher,
      SchoolClass,
      School,
      SchoolLocation,
      TeachingSchedule,
      TeachingSession,
      Employee,
      Subject,
      SubjectCatalog,
      TeachingApplication,
      TeachingScheduleNotificationLog,
      TeacherLocationChange,
      TeacherAccountRequest,
      FuelAllowanceTier,
      LessonImageEntity,
      Ward,
    ]),
  ],
  controllers: [
    SchoolClassController,
    TeacherController,
    TeachingScheduleController,
    TeachingSessionController,
    FuelAllowanceTierController,
  ],
  providers: [
    SubjectResolverService,
    SchoolClassService,
    TeacherService,
    TeacherMatchingService,
    AvatarStorageService,
    LessonImageStorageService,
    LessonImageLibraryService,
    TeachingScheduleService,
    TeachingSessionService,
    TeachingBulkService,
    FuelAllowanceTierService,
  ],
  exports: [
    SubjectResolverService,
    SchoolClassService,
    TeacherService,
    TeacherMatchingService,
    TeachingScheduleService,
    TeachingSessionService,
    TeachingBulkService,
    FuelAllowanceTierService,
  ],
})
export class TeachingModule {}
