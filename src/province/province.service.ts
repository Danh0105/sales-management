import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Province } from './province.entity';
import { CreateProvinceDto } from './dto/create-province.dto';
import { UpdateProvinceDto } from './dto/update-province.dto';
import { isRestrictedLongAnDirector } from '../long-an-director/long-an-scope.service';

@Injectable()
export class ProvinceService {
    constructor(
        @InjectRepository(Province)
        private readonly repo: Repository<Province>,
    ) { }

    async create(dto: CreateProvinceDto) {

        const existed = await this.repo
            .createQueryBuilder('p')
            .where(
                'LOWER(TRIM(p.name)) = LOWER(TRIM(:name))',
                {
                    name: dto.name,
                },
            )
            .getOne();

        if (existed) {
            throw new BadRequestException(
                'Tỉnh đã tồn tại',
            );
        }

        const province = this.repo.create({
            ...dto,
            name: dto.name.trim(),
        });

        return this.repo.save(province);
    }

    async findAll(user: any) {
        // salesadmin_la và Giám đốc Long An chỉ thấy tỉnh 7
        if (
            user.roles?.includes('salesadmin_la') ||
            isRestrictedLongAnDirector(user.roles)
        ) {
            return this.repo.find({
                where: {
                    id: 7,
                },
                order: {
                    id: 'ASC',
                },
            });
        }

        return this.repo.find({
            order: {
                id: 'ASC',
            },
        });
    }
    async findOne(id: number) {
        const province = await this.repo.findOne({ where: { id } });
        if (!province) {
            throw new NotFoundException('Province không tồn tại');
        }
        return province;
    }

    async update(id: number, dto: UpdateProvinceDto) {
        const province = await this.findOne(id);
        Object.assign(province, dto);
        return this.repo.save(province);
    }

    async remove(id: number) {
        const province = await this.findOne(id);
        return this.repo.remove(province);
    }
}