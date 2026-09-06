import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SubjectCatalog, normalizeSubjectName } from './subject-catalog.entity';
import { Subject } from '../subject/subject.entity';
import { CreateSubjectCatalogDto } from './dto/create-subject-catalog.dto';
import { UpdateSubjectCatalogDto } from './dto/update-subject-catalog.dto';

@Injectable()
export class SubjectCatalogsService {
    constructor(
        @InjectRepository(SubjectCatalog)
        private readonly catalogRepo: Repository<SubjectCatalog>,

        @InjectRepository(Subject)
        private readonly subjectRepo: Repository<Subject>,
    ) { }

    /**
     * Danh sách môn học trong danh mục.
     * Mặc định chỉ trả môn đang dùng (isActive = true) — dùng cho dropdown của NVKD.
     * Sales admin xem màn quản lý thì truyền includeInactive = true.
     */
    async findAll(options: { includeInactive?: boolean; search?: string } = {}) {
        const qb = this.catalogRepo
            .createQueryBuilder('catalog')
            .loadRelationCountAndMap('catalog.usageCount', 'catalog.subjects');

        if (!options.includeInactive) {
            qb.andWhere('catalog.is_active = true');
        }

        const search = options.search?.trim();
        if (search) {
            qb.andWhere(
                '(catalog.name ILIKE :search OR catalog.code ILIKE :search)',
                { search: `%${search}%` },
            );
        }

        return qb
            .orderBy('catalog.sort_order', 'ASC')
            .addOrderBy('catalog.name', 'ASC')
            .getMany();
    }

    async findOne(id: number) {
        const catalog = await this.catalogRepo
            .createQueryBuilder('catalog')
            .where('catalog.id = :id', { id })
            .loadRelationCountAndMap('catalog.usageCount', 'catalog.subjects')
            .getOne();

        if (!catalog) throw new NotFoundException('Không tìm thấy môn học trong danh mục');
        return catalog;
    }

    async create(dto: CreateSubjectCatalogDto) {
        const name = normalizeSubjectName(dto.name ?? '');
        if (!name) throw new BadRequestException('Tên môn học không được để trống');

        const duplicated = await this.findByName(name);
        if (duplicated) {
            throw new ConflictException(`Môn học "${duplicated.name}" đã có trong danh mục`);
        }

        const code = dto.code?.trim() || null;
        if (code) await this.assertCodeAvailable(code);

        const catalog = this.catalogRepo.create({
            name,
            code,
            description: dto.description?.trim() || null,
            isActive: dto.isActive ?? true,
            sortOrder: dto.sortOrder ?? 0,
        });

        return this.catalogRepo.save(catalog);
    }

    async update(id: number, dto: UpdateSubjectCatalogDto) {
        const catalog = await this.catalogRepo.findOne({ where: { id } });
        if (!catalog) throw new NotFoundException('Không tìm thấy môn học trong danh mục');

        if (dto.name !== undefined) {
            const name = normalizeSubjectName(dto.name ?? '');
            if (!name) throw new BadRequestException('Tên môn học không được để trống');

            const duplicated = await this.findByName(name);
            if (duplicated && duplicated.id !== id) {
                throw new ConflictException(`Môn học "${duplicated.name}" đã có trong danh mục`);
            }
            catalog.name = name;
        }

        if (dto.code !== undefined) {
            const code = dto.code?.trim() || null;
            if (code) await this.assertCodeAvailable(code, id);
            catalog.code = code;
        }

        if (dto.description !== undefined) {
            catalog.description = dto.description?.trim() || null;
        }

        if (dto.isActive !== undefined) catalog.isActive = dto.isActive;
        if (dto.sortOrder !== undefined) catalog.sortOrder = dto.sortOrder;

        return this.catalogRepo.save(catalog);
    }

    /**
     * Xoá môn khỏi danh mục. Nếu đã có trường dùng môn này thì KHÔNG xoá
     * (giữ dữ liệu cũ) — sales admin nên tắt `isActive` thay vì xoá.
     */
    async remove(id: number) {
        const catalog = await this.catalogRepo.findOne({ where: { id } });
        if (!catalog) throw new NotFoundException('Không tìm thấy môn học trong danh mục');

        const usageCount = await this.subjectRepo.count({
            where: { catalogId: id },
        });

        if (usageCount > 0) {
            throw new ConflictException(
                `Môn "${catalog.name}" đang được ${usageCount} môn học của trường sử dụng. ` +
                'Hãy tắt "đang sử dụng" thay vì xoá.',
            );
        }

        await this.catalogRepo.remove(catalog);
        return { deleted: true, id };
    }

    /** Tìm theo tên, không phân biệt hoa/thường và khoảng trắng thừa. */
    async findByName(name: string) {
        const normalized = normalizeSubjectName(name ?? '');
        if (!normalized) return null;

        return this.catalogRepo
            .createQueryBuilder('catalog')
            .where('LOWER(catalog.name) = LOWER(:name)', { name: normalized })
            .getOne();
    }

    /**
     * Xác định môn trong danh mục cho một môn học của trường.
     * - Có `catalogId` → dùng đúng môn đó (bắt buộc còn `isActive` khi tạo mới).
     * - Chỉ có `name` (client cũ) → tra theo tên; không khớp danh mục thì báo lỗi.
     */
    async resolveForSubject(
        input: { catalogId?: number | null; name?: string | null },
        options: { requireActive?: boolean } = {},
    ): Promise<SubjectCatalog> {
        if (input.catalogId !== undefined && input.catalogId !== null) {
            const catalog = await this.catalogRepo.findOne({
                where: { id: Number(input.catalogId) },
            });

            if (!catalog) {
                throw new BadRequestException(
                    'Môn học không tồn tại trong danh mục. Vui lòng chọn lại.',
                );
            }

            if (options.requireActive && !catalog.isActive) {
                throw new BadRequestException(
                    `Môn "${catalog.name}" đã ngừng sử dụng. Vui lòng chọn môn khác.`,
                );
            }

            return catalog;
        }

        const name = normalizeSubjectName(input.name ?? '');
        if (!name) {
            throw new BadRequestException('Vui lòng chọn môn học từ danh mục');
        }

        const catalog = await this.findByName(name);
        if (!catalog) {
            throw new BadRequestException(
                `Môn "${name}" chưa có trong danh mục môn học. ` +
                'Vui lòng chọn môn có sẵn hoặc liên hệ sales admin để thêm môn mới.',
            );
        }

        if (options.requireActive && !catalog.isActive) {
            throw new BadRequestException(
                `Môn "${catalog.name}" đã ngừng sử dụng. Vui lòng chọn môn khác.`,
            );
        }

        return catalog;
    }

    private async assertCodeAvailable(code: string, ignoreId?: number) {
        const qb = this.catalogRepo
            .createQueryBuilder('catalog')
            .where('LOWER(catalog.code) = LOWER(:code)', { code });

        if (ignoreId) qb.andWhere('catalog.id != :ignoreId', { ignoreId });

        const existed = await qb.getOne();
        if (existed) {
            throw new ConflictException(`Mã môn "${code}" đã được dùng cho môn "${existed.name}"`);
        }
    }
}
