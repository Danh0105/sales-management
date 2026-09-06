import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SubjectCatalog } from './subject-catalog.entity';
import { Subject } from '../subject/subject.entity';
import { SubjectCatalogsService } from './subject-catalog.service';
import { SubjectCatalogsController } from './subject-catalog.controller';

@Module({
    imports: [TypeOrmModule.forFeature([SubjectCatalog, Subject])],
    controllers: [SubjectCatalogsController],
    providers: [SubjectCatalogsService],
    exports: [SubjectCatalogsService],
})
export class SubjectCatalogsModule { }
