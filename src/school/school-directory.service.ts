import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SchoolDirectoryQueryDto } from './dto/school-directory-query.dto';
import { School } from './schools.entity';

const DEFAULT_LIMIT = 50;

/**
 * Danh mục trường cho hệ thống khác. Không dùng lại `SchoolsService`: các hàm đó
 * nạp cả nhân viên phụ trách và chi phí của trường. Chỉ cột liệt kê ở đây mới
 * được đọc và trả ra — thêm trường dữ liệu là quyết định có chủ ý.
 */
@Injectable()
export class SchoolDirectoryService {
    constructor(
        @InjectRepository(School)
        private readonly schoolRepo: Repository<School>,
    ) {}

    private baseQuery() {
        return this.schoolRepo
            .createQueryBuilder('school')
            .leftJoin('school.ward', 'ward')
            .leftJoin('ward.province', 'province')
            .select([
                'school.id',
                'school.name',
                'school.address',
                'school.phone',
                'school.taxCode',
                'school.budgetCode',
                'school.representative',
                'school.scale',
                'school.classCount',
                'school.status',
                'ward.id',
                'ward.name',
                'province.id',
                'province.name',
            ]);
    }

    private toItem(school: School) {
        const { ward } = school;
        return {
            id: school.id,
            name: school.name,
            address: school.address,
            phone: school.phone,
            taxCode: school.taxCode,
            budgetCode: school.budgetCode,
            representative: school.representative,
            scale: school.scale,
            classCount: school.classCount,
            status: school.status,
            ward: ward ? { id: ward.id, name: ward.name } : null,
            province: ward?.province
                ? { id: ward.province.id, name: ward.province.name }
                : null,
        };
    }

    async findAll(query: SchoolDirectoryQueryDto) {
        const page = query.page ?? 1;
        const limit = query.limit ?? DEFAULT_LIMIT;
        const qb = this.baseQuery().orderBy('school.id', 'ASC');

        const keyword = query.keyword?.trim();
        if (keyword) {
            qb.andWhere(
                '(school.name ILIKE :keyword OR school.taxCode ILIKE :keyword)',
                { keyword: `%${keyword.replace(/[\\%_]/g, '\\$&')}%` },
            );
        }
        if (query.provinceId) {
            qb.andWhere('ward.province_id = :provinceId', {
                provinceId: query.provinceId,
            });
        }
        if (query.wardId) {
            qb.andWhere('ward.id = :wardId', { wardId: query.wardId });
        }

        const [schools, total] = await qb
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();
        const totalPages = Math.ceil(total / limit);
        return {
            data: schools.map((school) => this.toItem(school)),
            pagination: {
                total,
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
            },
        };
    }

    async findOne(id: number) {
        const school = await this.baseQuery()
            .where('school.id = :id', { id })
            .getOne();
        if (!school) throw new NotFoundException('Không tìm thấy trường');
        return this.toItem(school);
    }
}
