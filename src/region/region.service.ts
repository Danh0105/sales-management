// region.service.ts
import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { Region } from './region.entity';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { Department } from 'src/department/department.entity';

@Injectable()
export class RegionService {
    constructor(
        @InjectRepository(Region)
        private readonly repo: Repository<Region>,

        @InjectRepository(Department)
        private readonly departmentRepo: Repository<Department>,
    ) { }

    // CREATE
    async create(dto: CreateRegionDto): Promise<Region> {
        const parent = dto.parentId
            ? await this.repo.findOne({ where: { id: dto.parentId } })
            : null;

        if (dto.parentId && !parent) {
            throw new NotFoundException('Parent region not found');
        }

        // 👇 load department
        const department = await this.departmentRepo.findOne({
            where: { id: dto.departmentId },
        });

        if (!department) {
            throw new NotFoundException('Department not found');
        }

        const region = this.repo.create({
            name: dto.name,
            parent,
            department,
        });

        return this.repo.save(region);
    }

    // GET ALL (tree nhẹ)
    async findAll(): Promise<Region[]> {
        return this.repo.find({
            relations: ['parent'],
            order: { id: 'ASC' },
        });
    }

    // GET ONE
    async findOne(id: number): Promise<Region> {
        const region = await this.repo.findOne({
            where: { id },
            relations: ['parent', 'children'],
        });

        if (!region) {
            throw new NotFoundException('Region not found');
        }

        return region;
    }

    // UPDATE
    async update(id: number, dto: UpdateRegionDto): Promise<Region> {
        const region = await this.findOne(id);

        if (dto.name !== undefined) {
            region.name = dto.name;
        }

        if (dto.parentId !== undefined) {
            if (dto.parentId === null) {
                region.parent = null;
            } else {
                if (dto.parentId === id) {
                    throw new BadRequestException('Cannot set itself as parent');
                }

                const parent = await this.repo.findOne({
                    where: { id: dto.parentId },
                });

                if (!parent) {
                    throw new NotFoundException('Parent region not found');
                }

                const isLoop = await this.isDescendant(parent.id, id);
                if (isLoop) {
                    throw new BadRequestException('Invalid parent (circular)');
                }

                region.parent = parent;
            }
        }

        return this.repo.save(region);
    }
    // DELETE
    async remove(id: number): Promise<void> {
        const region = await this.findOne(id);
        await this.repo.remove(region);
    }

    // =========================
    // HELPER: check loop cây
    // =========================
    private async isDescendant(
        parentId: number,
        childId: number,
    ): Promise<boolean> {
        let current = await this.repo.findOne({
            where: { id: parentId },
            relations: ['parent'],
        });

        while (current?.parent) {
            if (current.parent.id === childId) return true;

            current = await this.repo.findOne({
                where: { id: current.parent.id },
                relations: ['parent'],
            });
        }

        return false;
    }

    async getRegionsByDepartment(departmentId: number) {
        const regions = await this.repo.find({
            where: {
                department: { id: departmentId },
            },
        });

        return regions;
    }
}