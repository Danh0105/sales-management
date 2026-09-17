import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, IsNull, Repository } from 'typeorm';

import { School } from './schools.entity';
import { CreateSchoolDto } from './dto/create-school.dto';
import { UpdateSchoolDto } from './dto/update-school.dto';
import { Employee } from '../employee/employee.entity';

@Injectable()
export class SchoolsService {
    constructor(
        @InjectRepository(School)
        private schoolRepo: Repository<School>,

        @InjectRepository(Employee)
        private employeeRepo: Repository<Employee>,
    ) { }
    async getByEmployeeAndWard(employeeId: number, wardId: number) {
        return this.schoolRepo.find({
            where: {
                employee: { id: employeeId },
                ward: { id: wardId },
            },
            relations: ['subjects'],
            order: { name: 'ASC' },
        });
    }
    async findByWard(wardId: number) {
        return this.schoolRepo.find({
            where: {
                ward: { id: wardId },
            },
            relations: ['employee', 'subjects'],
            order: { name: 'ASC' },
        });
    }

    async create(dto: CreateSchoolDto) {
        this.normalizeLocation(dto);
        let employee: Employee | undefined;

        if (dto.employeeId) {
            employee = await this.employeeRepo.findOne({
                where: { id: dto.employeeId },
            }) ?? undefined;
        }

        const school = this.schoolRepo.create({
            ...dto,

            ...(employee && { employee }),

            ...(dto.employeeRegionId && {
                employeeRegion: {
                    id: dto.employeeRegionId,
                },

            }),
            ...(dto.wardId && {
                ward: {
                    id: dto.wardId,
                },
            }),
        });

        return this.schoolRepo.save(school);
    }

    async resolveGoogleMaps(sharedUrl: string) {
        let url: URL;
        try {
            url = new URL(sharedUrl);
        } catch {
            throw new BadRequestException('Link Google Maps không hợp lệ');
        }

        const hostname = url.hostname.toLowerCase();
        const allowedHosts = [
            'maps.app.goo.gl',
            'goo.gl',
            'maps.google.com',
            'www.google.com',
            'google.com',
        ];
        if (url.protocol !== 'https:' || !allowedHosts.includes(hostname)) {
            throw new BadRequestException('Chỉ hỗ trợ link chia sẻ Google Maps');
        }

        let resolvedUrl = sharedUrl;
        if (hostname === 'maps.app.goo.gl' || hostname === 'goo.gl') {
            try {
                resolvedUrl = await this.followGoogleMapsRedirects(sharedUrl, allowedHosts);
            } catch {
                throw new BadRequestException('Không mở được link chia sẻ Google Maps');
            }
        }

        const coordinates = this.extractCoordinates(resolvedUrl);
        if (!coordinates) {
            throw new BadRequestException('Không đọc được vị trí từ link Google Maps');
        }
        return coordinates;
    }

    async findAll(
        query: any,
    ) {
        const page = Number(query.page || 1);
        const limit = Number(query.limit || 10);
    
        const hasRemainingExpense =
            query.hasRemainingExpense === 'true';

        const employeeName: string | undefined =
            query.employeeName?.trim();

        // TOTAL TẤT CẢ TRƯỜNG
        const totalAllSchools =
            await this.schoolRepo.count();

        const qb = this.schoolRepo
            .createQueryBuilder('school')
            .leftJoinAndSelect(
                'school.employee',
                'employee',
            )
            .leftJoinAndSelect(
                'school.ward',
                'ward',
            )
            .leftJoinAndSelect(
                'school.schoolExpenses',
                'schoolExpenses',
            )
            .leftJoinAndSelect(
                'schoolExpenses.expenseItems',
                'expenseItems',
            )
            .orderBy('school.id', 'DESC');

        // FILTER CÒN CHI
        if (hasRemainingExpense) {
            qb.andWhere(
                'expenseItems.remainingOutsideExpense > 0',
            );
        }

        // FILTER THEO TÊN NHÂN VIÊN QUẢN LÝ
        if (employeeName) {
            qb.andWhere('employee.name ILIKE :employeeName', {
                employeeName: `%${employeeName}%`,
            });
        }

        // PAGINATION
        qb.skip((page - 1) * limit);
        qb.take(limit);
    
        const [data, total] =
            await qb.getManyAndCount();
    
        const totalPages = Math.ceil(total / limit);
    
        return {
            data,
    
            statistics: {
                totalAllSchools,
                totalFilteredSchools: total,
            },
    
            pagination: {
                total,
                page,
                limit,
                totalPages,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1,
            },
        };
    }
    async findByEmployee(employeeId: number) {
        return this.schoolRepo.find({
            where: {
                employee: { id: employeeId },
            },
            // Kèm phường/xã + khu vực để FE hiển thị đủ thông tin trường và
            // chọn sẵn địa bàn khi sửa (danh sách này không có nơi nào khác lấy được).
            relations: ['ward', 'ward.province'],
            order: { id: 'DESC' },
        });
    }
    async findOne(id: number) {
        const school = await this.schoolRepo.findOne({
            where: { id },
            relations: ['employee'],
        });

        if (!school) throw new NotFoundException('School not found');
        return school;
    }

    async update(id: number, dto: UpdateSchoolDto) {
        this.normalizeLocation(dto);
        const school = await this.findOne(id);

        const { employeeId, ...rest } = dto;

        // 🔥 xử lý employee riêng
        if (employeeId !== undefined) {
            const employee = await this.employeeRepo.findOne({
                where: { id: employeeId },
            });

            if (!employee) {
                throw new NotFoundException('Employee not found');
            }

            school.employee = employee; // ✅ không null
        }

        // 🔥 chỉ assign field hợp lệ
        Object.assign(school, rest);

        return this.schoolRepo.save(school);
    }

    private normalizeLocation(dto: CreateSchoolDto | UpdateSchoolDto): void {
        const hasLatitude = Object.prototype.hasOwnProperty.call(dto, 'latitude');
        const hasLongitude = Object.prototype.hasOwnProperty.call(dto, 'longitude');

        // Gửi null ở một trong hai phía là yêu cầu xoá toàn bộ vị trí.
        if ((hasLatitude && dto.latitude === null) || (hasLongitude && dto.longitude === null)) {
            dto.latitude = null;
            dto.longitude = null;
            dto.checkinRadius = null;
            dto.googleMapsUrl = null;
            return;
        }

        if (hasLatitude !== hasLongitude) {
            throw new BadRequestException('Cần đủ cả vĩ độ và kinh độ');
        }
    }

    private extractCoordinates(value: string): { latitude: number; longitude: number } | null {
        const decoded = decodeURIComponent(value);
        const patterns = [
            /!3d(-?\d+(?:\.\d+))!4d(-?\d+(?:\.\d+))/,
            /[?&](?:q|query|ll|center|daddr|sll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
            /\/place\/(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
            /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
        ];

        for (const pattern of patterns) {
            const match = decoded.match(pattern);
            if (!match) continue;
            const latitude = Number(match[1]);
            const longitude = Number(match[2]);
            if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
                return { latitude, longitude };
            }
        }
        return null;
    }

    private async followGoogleMapsRedirects(sharedUrl: string, allowedHosts: string[]): Promise<string> {
        let currentUrl = sharedUrl;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
                const current = new URL(currentUrl);
                if (current.protocol !== 'https:' || !allowedHosts.includes(current.hostname.toLowerCase())) {
                    throw new Error('Unsafe redirect');
                }

                const response = await fetch(currentUrl, {
                    method: 'GET',
                    redirect: 'manual',
                    signal: controller.signal,
                    headers: { 'user-agent': 'Mozilla/5.0' },
                });

                if (response.status < 300 || response.status >= 400) {
                    await response.body?.cancel();
                    return currentUrl;
                }

                const location = response.headers.get('location');
                await response.body?.cancel();
                if (!location || redirectCount === 5) throw new Error('Too many redirects');
                currentUrl = new URL(location, currentUrl).toString();
            }
        } finally {
            clearTimeout(timeout);
        }

        throw new Error('Cannot resolve URL');
    }

    async remove(id: number) {
        const school = await this.findOne(id);
        return this.schoolRepo.remove(school);
    }

    async updateStatus(id: number, status: number) {
        const result = await this.schoolRepo.update(id, { status });

        if (result.affected === 0) {
            throw new NotFoundException('School not found');
        }

        return { message: 'Update success' };
    }
    async findByEmployeeRegion(regionId: number) {
        return this.schoolRepo.find({
            where: {
                ward: {
                    id: regionId,
                },
            },
            relations: ['employee', 'ward', 'subjects'],
            order: { id: 'DESC' },
        });
    }
    async findByProvince(provinceId: number) {
        return this.schoolRepo.find({
            where: {
                ward: {
                    province: {
                        id: provinceId,
                    },
                },
            },
            relations: [
                'employee',
                'ward',
                'ward.province',
                'subjects',
            ],
            order: { id: 'DESC' },
        });
    }
    /**
     * Tìm trường "thông minh" hơn ILIKE đơn giản trước đây:
     * - Không phân biệt dấu tiếng Việt (dùng extension `unaccent` của Postgres),
     *   gõ "quang trung" vẫn ra "THCS Quang Trung".
     * - Tách từ khoá thành nhiều từ, mỗi từ phải khớp ít nhất 1 cột (AND giữa
     *   các từ, OR giữa các cột) — gõ "thcs trung" (thiếu chữ, sai thứ tự) vẫn
     *   ra "THCS Quang Trung" thay vì phải gõ đúng liền một cụm.
     * - Khớp trọn tên trường được xếp lên đầu danh sách.
     */
    async search(keyword: string) {
        const words = keyword.trim().split(/\s+/).filter(Boolean);
        if (!words.length) {
            return this.schoolRepo.find({
                relations: ['employee', 'ward', 'subjects'],
                order: { id: 'DESC' },
            });
        }

        const qb = this.schoolRepo
            .createQueryBuilder('school')
            .leftJoinAndSelect('school.employee', 'employee')
            .leftJoinAndSelect('school.ward', 'ward')
            .leftJoinAndSelect('school.subjects', 'subjects');

        words.forEach((word, i) => {
            const p = `kw${i}`;
            qb.andWhere(
                new Brackets((sub) => {
                    sub
                        .where(`unaccent(school.name) ILIKE unaccent(:${p})`, { [p]: `%${word}%` })
                        .orWhere(`unaccent(school.address) ILIKE unaccent(:${p})`, { [p]: `%${word}%` })
                        .orWhere(`unaccent(school.representative) ILIKE unaccent(:${p})`, { [p]: `%${word}%` })
                        .orWhere(`school.tax_code ILIKE :${p}`, { [p]: `%${word}%` })
                        .orWhere(`school.phone ILIKE :${p}`, { [p]: `%${word}%` })
                        .orWhere(`unaccent(employee.name) ILIKE unaccent(:${p})`, { [p]: `%${word}%` });
                }),
            );
        });

        return qb
            .addSelect(
                `CASE WHEN unaccent(school.name) ILIKE unaccent(:fullKeyword) THEN 0 ELSE 1 END`,
                'name_match_rank',
            )
            .setParameter('fullKeyword', `%${keyword.trim()}%`)
            .orderBy('name_match_rank', 'ASC')
            .addOrderBy('school.id', 'DESC')
            .getMany();
    }

    // 🔒 Full-text search bị giới hạn trong phạm vi trường do chính nhân viên quản lý
    async searchMySchools(employeeId: number, keyword?: string) {
        const qb = this.schoolRepo
            .createQueryBuilder('school')
            .leftJoinAndSelect('school.employee', 'employee')
            .leftJoinAndSelect('school.ward', 'ward')
            .leftJoinAndSelect('school.subjects', 'subjects')
            .where('employee.id = :employeeId', { employeeId });

        if (keyword) {
            qb.andWhere(
                new Brackets((sub) => {
                    sub
                        .where('school.name ILIKE :keyword', { keyword: `%${keyword}%` })
                        .orWhere('school.tax_code ILIKE :keyword', { keyword: `%${keyword}%` })
                        .orWhere('school.phone ILIKE :keyword', { keyword: `%${keyword}%` })
                        .orWhere('school.address ILIKE :keyword', { keyword: `%${keyword}%` })
                        .orWhere('school.representative ILIKE :keyword', { keyword: `%${keyword}%` });
                }),
            );
        }

        return qb.orderBy('school.id', 'DESC').getMany();
    }

    // Lọc danh sách trường theo tên nhân viên quản lý (không giới hạn phạm vi)
    async findByEmployeeName(employeeName: string) {
        return this.schoolRepo
            .createQueryBuilder('school')
            .leftJoinAndSelect('school.employee', 'employee')
            .leftJoinAndSelect('school.ward', 'ward')
            .leftJoinAndSelect('school.subjects', 'subjects')
            .where('employee.name ILIKE :employeeName', {
                employeeName: `%${employeeName}%`,
            })
            .orderBy('school.id', 'DESC')
            .getMany();
    }
}
