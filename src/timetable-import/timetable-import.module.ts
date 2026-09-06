import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { School } from '../school/schools.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolClass } from '../teaching/entities/school-class.entity';
import { Teacher } from '../teaching/entities/teacher.entity';
import { TeachingModule } from '../teaching/teaching.module';

import { TimetableDraft } from './entities/timetable-draft.entity';
import { TimetableChatService } from './timetable-chat.service';
import { TimetableExtractService } from './timetable-extract.service';
import { TimetableImportController } from './timetable-import.controller';
import { TimetableImportService } from './timetable-import.service';
import { TimetableResolverService } from './timetable-resolver.service';

@Module({
    imports: [
        // Việc tạo lớp và xếp lịch đi qua service sẵn có của TeachingModule nên
        // mọi quy tắc nghiệp vụ giữ nguyên, không nhân bản logic.
        TeachingModule,
        TypeOrmModule.forFeature([
            TimetableDraft,
            School,
            Teacher,
            Subject,
            SchoolClass,
        ]),
    ],
    controllers: [TimetableImportController],
    providers: [
        TimetableImportService,
        TimetableExtractService,
        TimetableChatService,
        TimetableResolverService,
    ],
    exports: [TimetableImportService],
})
export class TimetableImportModule {}
