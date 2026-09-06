import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Employee } from '../employee/employee.entity';
import { Region } from '../region/region.entity';
import { EmployeeRegion } from './entities/employee-region.entity';
import { AssignRegionDto } from './dto/assign-region.dto';
import { HandoverRegionDto } from './dto/handover-region.dto';
import { Province } from '../province/province.entity';
import { Ward } from '../ward/ward.entity';

@Injectable()
export class EmployeeRegionService {
    constructor(
        @InjectRepository(EmployeeRegion)
        private readonly employeeRegionRepo: Repository<EmployeeRegion>,

        @InjectRepository(Employee)
        private readonly employeeRepo: Repository<Employee>,

        @InjectRepository(Region)
        private readonly regionRepo: Repository<Region>,

        @InjectRepository(Province)
        private readonly provinceRepo: Repository<Province>,

        @InjectRepository(Ward)
        private readonly wardRepo: Repository<Ward>,
    ) { }


    // Lấy region của employee
    /**
     * Khu vực của một nhân viên.
     *
     * Quan hệ là `province` + `ward`, **không phải** `region`: bảng
     * `employee_region` lưu theo tỉnh/phường, còn bảng `region` là thứ khác.
     * Trước đây hàm này xin `relations: ['region']` nên TypeORM ném
     * `EntityPropertyNotFoundError` ngay lúc dựng câu truy vấn — endpoint
     * `GET /regions/regions-by-employee/:id` trả 500 với mọi đầu vào, kể cả khi
     * bảng rỗng.
     */
    async getRegionsByEmployee(employeeId: number) {
        const data = await this.employeeRegionRepo.find({
            where: { employeeId },
            relations: ['province', 'ward'],
        });

        return data;
    }
    async getProvincesByEmployee(employeeId: number) {

        const rows = await this.employeeRegionRepo.find({
            where: {
                employeeId,
            },
            relations: ['province'],
        });

        const uniqueMap = new Map();

        for (const row of rows) {

            if (
                row.province &&
                !uniqueMap.has(row.province.id)
            ) {
                uniqueMap.set(
                    row.province.id,
                    row.province,
                );
            }
        }

        return Array.from(uniqueMap.values()).sort(
            (a, b) =>
                a.name.localeCompare(b.name),
        );
    }
    /**
     * Các tỉnh **chưa** giao cho nhân viên này — nguồn cho ô chọn khi phân khu vực.
     * Đã giao rồi mà vẫn hiện trong danh sách thì bấm thêm lần nữa chỉ tạo bản ghi thừa.
     */
    async getAvailableProvinces(employeeId: number) {
        const assigned = await this.employeeRegionRepo.find({
            where: { employeeId },
            select: ['provinceId'],
        });

        const assignedIds = assigned
            .map((row) => row.provinceId)
            .filter((id): id is number => Boolean(id));

        return this.provinceRepo.find({
            where: assignedIds.length ? { id: Not(In(assignedIds)) } : {},
            order: { name: 'ASC' },
        });
    }

    async addManyToProvince(employeeId: number, provinceIds: number[]) {
        const unique = [...new Set(provinceIds.filter(Boolean))];
        if (!unique.length) return [];

        // Bỏ tỉnh đã giao: bấm hai lần hoặc hai người cùng thao tác thì bảng
        // employee_region sẽ có bản ghi trùng, kéo theo số liệu đếm bị nhân đôi.
        const existed = await this.employeeRegionRepo.find({
            where: { employeeId, provinceId: In(unique) },
            select: ['provinceId'],
        });
        const existedIds = new Set(existed.map((row) => row.provinceId));

        const records = unique
            .filter((provinceId) => !existedIds.has(provinceId))
            .map((provinceId) =>
                this.employeeRegionRepo.create({ employeeId, provinceId }),
            );

        if (!records.length) return [];

        return this.employeeRegionRepo.save(records);
    }
    async removeProvince(employeeId: number, provinceId: number) {
        return this.employeeRegionRepo.delete({
            employeeId: employeeId,
            provinceId: provinceId,
        });
    }
    async assignRegion(dto: AssignRegionDto, user: any) {

        const currentRegions =
            await this.employeeRegionRepo.find({
                where: {
                    employeeId: dto.employeeId,
                },
            });

        const existedWardIds =
            currentRegions.map(
                (i) => i.wardId,
            );

        const wards = await this.wardRepo.findBy({
            id: In(dto.wardIds || []),
        });

        const data: EmployeeRegion[] = [];

        for (const ward of wards) {

            // salesadmin_la chỉ được tỉnh 7
            if (
                user.roles?.includes('salesadmin_la') &&
                ward.province_id !== 7
            ) {
                continue;
            }

            // đã tồn tại thì bỏ qua
            if (
                existedWardIds.includes(ward.id)
            ) {
                continue;
            }

            data.push(
                this.employeeRegionRepo.create({
                    employeeId: dto.employeeId,
                    provinceId: ward.province_id,
                    wardId: ward.id,
                }),
            );
        }

        if (data.length === 0) {
            return [];
        }

        return this.employeeRegionRepo.save(data);
    }
    async handoverRegion(
        dto: HandoverRegionDto,
    ) {

        const transferRows =
            await this.employeeRegionRepo.find({
                where: {
                    employeeId:
                        dto.fromEmployeeId,
                },
            });

        let rows = transferRows;

        // transfer theo tỉnh
        if (
            dto.provinceIds &&
            dto.provinceIds.length > 0
        ) {

            rows = rows.filter((r) =>
                dto.provinceIds?.includes(
                    r.provinceId,
                ),
            );
        }

        // transfer theo ward
        if (
            dto.wardIds &&
            dto.wardIds.length > 0
        ) {

            rows = rows.filter((r) =>
                dto.wardIds?.includes(
                    r.wardId,
                ),
            );
        }

        if (rows.length === 0) {
            return [];
        }

        // check duplicate bên nhận
        const existed =
            await this.employeeRegionRepo.find({
                where: {
                    employeeId:
                        dto.toEmployeeId,
                },
            });

        const existedWardIds =
            existed.map((i) => i.wardId);

        const insertData: EmployeeRegion[] =
            [];

        for (const row of rows) {

            // đã tồn tại bên nhận
            if (
                existedWardIds.includes(
                    row.wardId,
                )
            ) {
                continue;
            }

            insertData.push(
                this.employeeRegionRepo.create({
                    employeeId:
                        dto.toEmployeeId,
                    provinceId:
                        row.provinceId,
                    wardId: row.wardId,
                }),
            );
        }

        // thêm cho người nhận
        if (insertData.length > 0) {
            await this.employeeRegionRepo.save(
                insertData,
            );
        }

        // xoá bên bàn giao
        await this.employeeRegionRepo.delete(
            rows.map((r) => r.id),
        );

        return {
            transferred:
                insertData.length,
        };
    }
    async revokeProvince(
        employeeId: number,
        provinceId: number,
    ) {

        return this.employeeRegionRepo.delete({
            employeeId,
            provinceId,
        });
    }
    async revokeWard(
        employeeId: number,
        wardId: number,
    ) {

        return this.employeeRegionRepo.delete({
            employeeId,
            wardId,
        });
    }
}