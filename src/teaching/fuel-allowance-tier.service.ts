import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FuelAllowanceTier } from './entities/fuel-allowance-tier.entity';
import { Teacher } from './entities/teacher.entity';
import { School } from '../school/schools.entity';
import { SchoolLocation } from '../school-location/entities/school-location.entity';
import { Employee } from '../employee/employee.entity';
import { TEACHER_STAFF_ROLE } from './teaching-roles';
import { haversineKm } from './teacher-matching.service';
import {
  CreateFuelAllowanceTierDto,
  UpdateFuelAllowanceTierDto,
} from './dto/fuel-allowance-tier.dto';

/** Phụ cấp xăng cho một buổi dạy — chốt tại thời điểm tạo buổi. */
export interface GasAllowanceResult {
  /**
   * true = giáo viên công ty — luôn đúng bất kể `gasAllowance` có tra được
   * bậc hay không. Người gọi dùng field này để quyết định có bỏ
   * `ratePerPeriod` hay không: giáo viên công ty không nhận theo tiết, kể cả
   * khi chưa có vị trí/chưa khớp bậc nào (lúc đó phải báo thiếu cấu hình,
   * không được âm thầm trả theo tiết như cộng tác viên).
   */
  isCompanyTeacher: boolean;
  distanceToSchoolKm: number | null;
  gasAllowance: number | null;
}

const NO_ALLOWANCE: GasAllowanceResult = {
  isCompanyTeacher: false,
  distanceToSchoolKm: null,
  gasAllowance: null,
};

@Injectable()
export class FuelAllowanceTierService {
  constructor(
    @InjectRepository(FuelAllowanceTier)
    private readonly tierRepo: Repository<FuelAllowanceTier>,

    @InjectRepository(Teacher)
    private readonly teacherRepo: Repository<Teacher>,

    @InjectRepository(School)
    private readonly schoolRepo: Repository<School>,

    @InjectRepository(Employee)
    private readonly employeeRepo: Repository<Employee>,

    // Đặt cuối: test dựng service bằng tham số vị trí, chèn vào giữa là đẩy
    // lệch mọi dependency phía sau.
    @InjectRepository(SchoolLocation)
    private readonly locationRepo: Repository<SchoolLocation>,
  ) {}

  async findAll(): Promise<FuelAllowanceTier[]> {
    return this.tierRepo.find({ order: { minDistanceKm: 'ASC' } });
  }

  async create(dto: CreateFuelAllowanceTierDto): Promise<FuelAllowanceTier> {
    this.assertRange(dto.minDistanceKm, dto.maxDistanceKm);
    await this.assertNoOverlap(dto.minDistanceKm, dto.maxDistanceKm ?? null);

    const tier = this.tierRepo.create({
      minDistanceKm: dto.minDistanceKm,
      maxDistanceKm: dto.maxDistanceKm ?? null,
      amount: dto.amount,
    });
    return this.tierRepo.save(tier);
  }

  async update(
    id: number,
    dto: UpdateFuelAllowanceTierDto,
  ): Promise<FuelAllowanceTier> {
    const tier = await this.tierRepo.findOne({ where: { id } });
    if (!tier) throw new NotFoundException('Bậc phụ cấp xăng không tồn tại');

    const minDistanceKm = dto.minDistanceKm ?? tier.minDistanceKm;
    const maxDistanceKm =
      dto.maxDistanceKm !== undefined ? dto.maxDistanceKm : tier.maxDistanceKm;
    this.assertRange(minDistanceKm, maxDistanceKm);
    await this.assertNoOverlap(minDistanceKm, maxDistanceKm ?? null, id);

    tier.minDistanceKm = minDistanceKm;
    tier.maxDistanceKm = maxDistanceKm ?? null;
    if (dto.amount !== undefined) tier.amount = dto.amount;
    return this.tierRepo.save(tier);
  }

  async remove(id: number): Promise<{ deleted: true }> {
    const tier = await this.tierRepo.findOne({ where: { id } });
    if (!tier) throw new NotFoundException('Bậc phụ cấp xăng không tồn tại');
    await this.tierRepo.remove(tier);
    return { deleted: true };
  }

  private assertRange(
    minDistanceKm: number,
    maxDistanceKm?: number | null,
  ): void {
    if (maxDistanceKm != null && maxDistanceKm <= minDistanceKm) {
      throw new BadRequestException(
        'Khoảng cách tối đa phải lớn hơn khoảng cách tối thiểu',
      );
    }
  }

  /** Các bậc không được chồng khoảng cách lên nhau — tra theo khoảng cách phải ra đúng 1 bậc. */
  private async assertNoOverlap(
    minDistanceKm: number,
    maxDistanceKm: number | null,
    exceptId?: number,
  ): Promise<void> {
    const all = await this.tierRepo.find();
    const others = exceptId ? all.filter((t) => t.id !== exceptId) : all;
    const upperBound = maxDistanceKm ?? Infinity;
    const overlapped = others.find((other) => {
      const otherUpper = other.maxDistanceKm ?? Infinity;
      return minDistanceKm < otherUpper && other.minDistanceKm < upperBound;
    });
    if (overlapped) {
      throw new ConflictException(
        `Khoảng cách chồng lên bậc đã có (${overlapped.minDistanceKm}` +
          `${overlapped.maxDistanceKm != null ? `-${overlapped.maxDistanceKm}` : '+'} km)`,
      );
    }
  }

  private resolveAmount(
    tiers: FuelAllowanceTier[],
    distanceKm: number,
  ): number | null {
    const tier = tiers.find(
      (t) =>
        distanceKm >= t.minDistanceKm &&
        (t.maxDistanceKm == null || distanceKm <= t.maxDistanceKm),
    );
    return tier ? tier.amount : null;
  }

  /**
   * Phụ cấp xăng cho MỘT buổi dạy — chỉ có giá trị khi giáo viên là công ty
   * (`giaovien_congty`), đã có vị trí, trường/điểm trường có toạ độ, và có bậc khớp
   * khoảng cách. Mọi trường hợp khác trả về `null` (giáo viên cộng tác viên
   * không cần cung cấp vị trí — không phải lỗi, chỉ là không áp dụng).
   *
   * Nếu schoolLocationId được truyền, sẽ dùng toạ độ của location; nếu không hoặc
   * location chưa có toạ độ, fallback về toạ độ trường.
   */
  async computeForTeacherSchool(
    teacherId: number | null | undefined,
    schoolId: number | null | undefined,
    schoolLocationId?: number | null,
  ): Promise<GasAllowanceResult> {
    if (!teacherId || !schoolId) return NO_ALLOWANCE;

    const teacher = await this.teacherRepo.findOne({
      where: { id: teacherId },
    });
    if (!teacher?.employeeId) return NO_ALLOWANCE;

    const employee = await this.employeeRepo.findOne({
      where: { id: teacher.employeeId },
    });
    if (!employee?.roles?.includes(TEACHER_STAFF_ROLE)) return NO_ALLOWANCE;

    // Từ đây chắc chắn là giáo viên công ty — dù không tra được khoảng cách
    // (thiếu vị trí/toạ độ trường/chưa khai bậc) vẫn phải báo `isCompanyTeacher`
    // để nơi gọi bỏ `ratePerPeriod`, không được âm thầm trả theo tiết.
    if (teacher.latitude == null || teacher.longitude == null) {
      return { isCompanyTeacher: true, distanceToSchoolKm: null, gasAllowance: null };
    }

    const school = await this.schoolRepo.findOne({ where: { id: schoolId } });

    let lat = school?.latitude;
    let lng = school?.longitude;

    if (schoolLocationId) {
      const location = await this.locationRepo.findOne({ where: { id: schoolLocationId } });
      if (location?.latitude != null && location?.longitude != null) {
        lat = location.latitude;
        lng = location.longitude;
      }
    }

    if (lat == null || lng == null) {
      return { isCompanyTeacher: true, distanceToSchoolKm: null, gasAllowance: null };
    }

    const distanceKm =
      Math.round(
        haversineKm(
          teacher.latitude,
          teacher.longitude,
          lat,
          lng,
        ) * 100,
      ) / 100;

    const tiers = await this.findAll();
    const gasAllowance = this.resolveAmount(tiers, distanceKm);

    return { isCompanyTeacher: true, distanceToSchoolKm: distanceKm, gasAllowance };
  }
}
