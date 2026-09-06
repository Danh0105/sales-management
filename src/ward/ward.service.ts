import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ward } from './ward.entity';
import { CreateWardDto } from './dto/create-ward.dto';
import { UpdateWardDto } from './dto/update-ward.dto';
import { EmployeeRegion } from '../employee-region-school/entities/employee-region.entity';

@Injectable()
export class WardService {
    constructor(
        @InjectRepository(Ward)
        private readonly repo: Repository<Ward>,

        @InjectRepository(EmployeeRegion)
        private readonly employeeRegionRepo: Repository<EmployeeRegion>,
    ) { }

    async create(dto: CreateWardDto) {

        const existed = await this.repo
            .createQueryBuilder('w')
            .where(
                'LOWER(TRIM(w.name)) = LOWER(TRIM(:name))',
                {
                    name: dto.name,
                },
            )
            .andWhere(
                'w.province_id = :provinceId',
                {
                    provinceId: dto.province_id,
                },
            )
            .getOne();

        if (existed) {
            throw new BadRequestException(
                'Khu vực đã tồn tại trong tỉnh này',
            );
        }

        const ward = this.repo.create({
            ...dto,
            name: dto.name.trim(),
        });

        return this.repo.save(ward);
    }
    async findAll() {
        return this.repo.find({
            relations: ['province'],
            order: { id: 'ASC' },
        });
    }

    async findByProvince(provinceId: number) {
        const wards = await this.repo
            .createQueryBuilder('ward')

            .leftJoin(
                'employee_region',
                'er',
                'er.ward_id = ward.id'
            )

            .leftJoin(
                'employee',
                'emp',
                'emp.id = er.employee_id'
            )

            .select([
                'ward.id AS id',
                'ward.name AS name',

                'emp.id AS employee_id',
                'emp.name AS employee_name',
            ])

            .where('ward.province_id = :provinceId', {
                provinceId,
            })

            .orderBy('ward.name', 'ASC')

            .getRawMany();

        return wards.map((w) => ({
            id: w.id,
            name: w.name,

            employee: w.employee_id
                ? {
                    id: w.employee_id,
                    name: w.employee_name,
                }
                : null,
        }));
    }

    async findOne(id: number) {
        const ward = await this.repo.findOne({
            where: { id },
            relations: ['province'],
        });

        if (!ward) {
            throw new NotFoundException('Ward không tồn tại');
        }

        return ward;
    }

    async update(id: number, dto: UpdateWardDto) {
        const ward = await this.findOne(id);
        Object.assign(ward, dto);
        return this.repo.save(ward);
    }

    async remove(id: number) {
        const ward = await this.findOne(id);
        return this.repo.remove(ward);
    }
    async getWardsByEmployee(
        employeeId: number,
        provinceId?: number,
    ) {
        const query = this.employeeRegionRepo
            .createQueryBuilder('er')

            .leftJoin('er.ward', 'w')

            .leftJoin('w.schools', 's')

            .select([
                'w.id AS id',
                'w.name AS name',
                'w.province_id AS province_id',
                'COUNT(s.id) AS "schoolCount"',
            ])

            .where(
                'er.employee_id = :employeeId',
                { employeeId },
            );

        // FILTER PROVINCE
        if (provinceId) {
            query.andWhere(
                'w.province_id = :provinceId',
                { provinceId },
            );
        }

        const data = await query
            .groupBy('w.id')
            .addGroupBy('w.name')
            .addGroupBy('w.province_id')

            .orderBy('COUNT(s.id)', 'DESC')
            .addOrderBy('w.name', 'ASC')

            .getRawMany();

        return data.map((item) => ({
            ...item,
            schoolCount: Number(item.schoolCount),
        }));
    }

}