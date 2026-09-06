import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SchoolLocation } from './entities/school-location.entity';
import { School } from '../school/schools.entity';
import { SchoolsService } from '../school/schools.service';
import { CreateSchoolLocationDto } from './dto/create-school-location.dto';
import { UpdateSchoolLocationDto } from './dto/update-school-location.dto';

@Injectable()
export class SchoolLocationService {
    constructor(
        @InjectRepository(SchoolLocation)
        private readonly locationRepo: Repository<SchoolLocation>,
        @InjectRepository(School)
        private readonly schoolRepo: Repository<School>,
        private readonly schoolsService: SchoolsService,
    ) {}

    async create(dto: CreateSchoolLocationDto): Promise<SchoolLocation> {
        const school = await this.schoolRepo.findOne({ where: { id: dto.schoolId } });
        if (!school) {
            throw new NotFoundException(`Trường ${dto.schoolId} không tồn tại`);
        }

        const existing = await this.locationRepo.findOne({
            where: { schoolId: dto.schoolId, name: dto.name },
        });
        if (existing) {
            throw new BadRequestException(
                `Trường này đã có điểm trường tên "${dto.name}"`,
            );
        }

        const location = this.locationRepo.create(dto);

        // Resolve Google Maps URL if provided (reuse SchoolsService logic)
        if (dto.googleMapsUrl) {
            try {
                const coords = await this.schoolsService.resolveGoogleMaps(
                    dto.googleMapsUrl,
                );
                location.latitude = coords.latitude;
                location.longitude = coords.longitude;
            } catch (err) {
                // Log the error but don't fail — URL can be resolved manually later
                console.warn(`Failed to resolve Google Maps URL: ${err.message}`);
            }
        }

        return this.locationRepo.save(location);
    }

    async findBySchool(schoolId: number): Promise<SchoolLocation[]> {
        return this.locationRepo.find({
            where: { schoolId },
            relations: ['ward'],
            order: { name: 'ASC' },
        });
    }

    async findOne(id: number): Promise<SchoolLocation> {
        const location = await this.locationRepo.findOne({
            where: { id },
            relations: ['school', 'ward'],
        });
        if (!location) {
            throw new NotFoundException(`Điểm trường ${id} không tồn tại`);
        }
        return location;
    }

    async update(
        id: number,
        dto: UpdateSchoolLocationDto,
    ): Promise<SchoolLocation> {
        const location = await this.findOne(id);

        // Resolve Google Maps URL if provided
        if (dto.googleMapsUrl) {
            try {
                const coords = await this.schoolsService.resolveGoogleMaps(
                    dto.googleMapsUrl,
                );
                location.latitude = coords.latitude;
                location.longitude = coords.longitude;
            } catch (err) {
                console.warn(`Failed to resolve Google Maps URL: ${err.message}`);
            }
        }

        Object.assign(location, dto);
        return this.locationRepo.save(location);
    }

    async remove(id: number): Promise<void> {
        const location = await this.findOne(id);
        await this.locationRepo.remove(location);
    }

    async updateStatus(id: number, status: number): Promise<SchoolLocation> {
        const location = await this.findOne(id);
        location.status = status;
        return this.locationRepo.save(location);
    }

    /**
     * Validate that a location belongs to a specific school.
     * Used by SchoolClassService, SubjectsService, etc. when a location is optionally
     * linked to an entity.
     */
    async assertBelongsToSchool(
        locationId: number,
        schoolId: number,
    ): Promise<void> {
        const location = await this.locationRepo.findOne({
            where: { id: locationId, schoolId },
        });
        if (!location) {
            throw new BadRequestException(
                `Điểm trường ${locationId} không thuộc trường ${schoolId}`,
            );
        }
    }
}
