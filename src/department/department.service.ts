// department.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './department.entity';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';

@Injectable()
export class DepartmentService {
    constructor(
        @InjectRepository(Department)
        private readonly departmentRepo: Repository<Department>,
    ) { }

    async create(dto: CreateDepartmentDto): Promise<Department> {
        const exist = await this.departmentRepo.findOne({
            where: { name: dto.name },
        });

        if (exist) {
            throw new BadRequestException('Department already exists');
        }

        const department = this.departmentRepo.create(dto);
        return this.departmentRepo.save(department);
    }

    async findAll(): Promise<Department[]> {
        return this.departmentRepo.find({
            relations: ['employees'],
        });
    }

    async findOne(id: number): Promise<Department> {
        const department = await this.departmentRepo.findOne({
            where: { id },
            relations: ['employees'],
        });

        if (!department) {
            throw new NotFoundException('Department not found');
        }

        return department;
    }

    async update(id: number, dto: UpdateDepartmentDto): Promise<Department> {
        const department = await this.findOne(id);

        if (dto.name) {
            const exist = await this.departmentRepo.findOne({
                where: { name: dto.name },
            });

            if (exist && exist.id !== id) {
                throw new BadRequestException('Department name already exists');
            }
        }

        Object.assign(department, dto);
        return this.departmentRepo.save(department);
    }

    async remove(id: number): Promise<void> {
        const department = await this.findOne(id);

        await this.departmentRepo.remove(department);
    }
}