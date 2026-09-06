import { PartialType } from '@nestjs/mapped-types';
import { CreateSubjectCatalogDto } from './create-subject-catalog.dto';

export class UpdateSubjectCatalogDto extends PartialType(
    CreateSubjectCatalogDto,
) { }
