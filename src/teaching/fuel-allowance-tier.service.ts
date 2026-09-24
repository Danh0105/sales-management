import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { FuelAllowanceTier } from './entities/fuel-allowance-tier.entity';
import { Teacher } from './entities/teacher.entity';
import { School } from '../school/schools.entity';
import { SchoolLocation } from '../school-location/entities/school-location.entity';
import { Employee } from '../employee/employee.entity';
import { Payroll } from '../payroll/entities/payroll.entity';
import { PayrollStatus } from '../payroll/payroll-status.enum';
import { TeachingSession } from './entities/teaching-session.entity';
import {
  TeacherLocationChange,
  TeacherLocationChangeStatus,
} from './entities/teacher-location-change.entity';
import { vnToday } from '../suggest/utils/vn-date';
import { toDateString } from './teaching.util';
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

/**
 * Vì sao một buổi của giáo viên công ty không có phụ cấp xăng. Một buổi có
 * thể thiếu nhiều thứ cùng lúc (vd. cả nhà lẫn trường chưa có toạ độ) — báo
 * đủ để người dùng bổ sung một lần, không phải sửa xong lại gặp lỗi mới.
 */
export type GasAllowanceMissingReason =
  /** Giáo viên chưa khai vị trí nhà. */
  | 'NO_TEACHER_LOCATION'
  /** Cả điểm trường lẫn trường đều chưa có toạ độ. */
  | 'NO_SCHOOL_LOCATION'
  /** Tính được km nhưng không có bậc phụ cấp nào phủ khoảng cách đó. */
  | 'NO_MATCHING_TIER'
  /** Khoảng cách vô lý (> 9999 km) — toạ độ nhà hoặc trường đang sai. */
  | 'INVALID_DISTANCE';

export interface GasAllowanceDiagnosis {
  distanceToSchoolKm: number | null;
  gasAllowance: number | null;
  /** Rỗng = tính được phụ cấp. */
  missingReasons: GasAllowanceMissingReason[];
}

type RawCoord = number | string | null | undefined;

/**
 * Danh sách việc cần bổ sung để các buổi có phụ cấp — gộp theo đúng đối
 * tượng phải sửa (giáo viên / điểm dạy / bậc) để người dùng sửa một lần là
 * xong cho mọi buổi liên quan.
 */
export interface GasAllowanceMissingReport {
  teachersWithoutLocation: {
    teacherId: number;
    teacherName: string;
    sessions: number;
  }[];
  placesWithoutLocation: {
    schoolId: number;
    schoolName: string | null;
    schoolLocationId: number | null;
    locationName: string | null;
    sessions: number;
  }[];
  distancesWithoutTier: {
    teacherId: number;
    teacherName: string;
    schoolId: number;
    schoolName: string | null;
    schoolLocationId: number | null;
    locationName: string | null;
    /** null = khoảng cách vô lý (`INVALID_DISTANCE`), toạ độ đang sai. */
    distanceKm: number | null;
    reason: 'NO_MATCHING_TIER' | 'INVALID_DISTANCE';
    sessions: number;
  }[];
}

/** Kết quả một lần tính lại phụ cấp cho các buổi đang trống. */
export interface RecomputeGasAllowanceResult {
  /** Số buổi vừa được điền phụ cấp. */
  updated: number;
  /** Buổi thuộc tháng đã gửi phiếu lương — cố ý không đụng tới. */
  skippedLocked: number;
  /** Vẫn chưa tính được — chi tiết cần bổ sung ở `missing`. */
  stillMissing: number;
  missing: GasAllowanceMissingReport;
}

/** Một dòng đầu vào để gom báo cáo thiếu phụ cấp. */
export interface MissingAllowanceEntry {
  teacherId: number;
  teacherName: string;
  schoolId: number;
  schoolName: string | null;
  schoolLocationId: number | null;
  locationName: string | null;
  diagnosis: GasAllowanceDiagnosis;
  sessions: number;
}

/** Gom các buổi thiếu phụ cấp theo đối tượng cần sửa. */
export function buildMissingAllowanceReport(
  entries: MissingAllowanceEntry[],
): GasAllowanceMissingReport {
  const teachers = new Map<number, GasAllowanceMissingReport['teachersWithoutLocation'][number]>();
  const places = new Map<string, GasAllowanceMissingReport['placesWithoutLocation'][number]>();
  const distances = new Map<string, GasAllowanceMissingReport['distancesWithoutTier'][number]>();

  for (const entry of entries) {
    const reasons = entry.diagnosis.missingReasons;
    if (reasons.includes('NO_TEACHER_LOCATION')) {
      const item = teachers.get(entry.teacherId) ?? {
        teacherId: entry.teacherId,
        teacherName: entry.teacherName,
        sessions: 0,
      };
      item.sessions += entry.sessions;
      teachers.set(entry.teacherId, item);
    }
    if (reasons.includes('NO_SCHOOL_LOCATION')) {
      const key = `${entry.schoolId}|${entry.schoolLocationId ?? ''}`;
      const item = places.get(key) ?? {
        schoolId: entry.schoolId,
        schoolName: entry.schoolName,
        schoolLocationId: entry.schoolLocationId,
        locationName: entry.locationName,
        sessions: 0,
      };
      item.sessions += entry.sessions;
      places.set(key, item);
    }
    const tierReason = reasons.find(
      (r): r is 'NO_MATCHING_TIER' | 'INVALID_DISTANCE' =>
        r === 'NO_MATCHING_TIER' || r === 'INVALID_DISTANCE',
    );
    if (tierReason) {
      const key = `${entry.teacherId}|${entry.schoolId}|${entry.schoolLocationId ?? ''}`;
      const item = distances.get(key) ?? {
        teacherId: entry.teacherId,
        teacherName: entry.teacherName,
        schoolId: entry.schoolId,
        schoolName: entry.schoolName,
        schoolLocationId: entry.schoolLocationId,
        locationName: entry.locationName,
        distanceKm: entry.diagnosis.distanceToSchoolKm,
        reason: tierReason,
        sessions: 0,
      };
      item.sessions += entry.sessions;
      distances.set(key, item);
    }
  }

  const bySessions = <T extends { sessions: number }>(list: T[]) =>
    list.sort((a, b) => b.sessions - a.sessions);
  return {
    teachersWithoutLocation: bySessions([...teachers.values()]),
    placesWithoutLocation: bySessions([...places.values()]),
    distancesWithoutTier: bySessions([...distances.values()]),
  };
}

const NO_ALLOWANCE: GasAllowanceResult = {
  isCompanyTeacher: false,
  distanceToSchoolKm: null,
  gasAllowance: null,
};

/** Giới hạn của cột `teaching_sessions.distance_to_school_km` — numeric(6,2). */
const MAX_DISTANCE_KM = 9999.99;

/**
 * `0, 0` là toạ độ KHAI THIẾU, không phải một địa điểm.
 *
 * Form nhập để trống hoặc lưu hụt đều ra `0, 0`, mà điểm đó nằm giữa Đại Tây
 * Dương: mọi trường ở Việt Nam cách nó ~11.800 km. Tính thật con số đó vừa vô
 * nghĩa (phụ cấp xăng luôn rơi vào bậc cao nhất) vừa làm vỡ cột khoảng cách
 * khi ghi buổi dạy. Coi như chưa có toạ độ để lùi về nhánh an toàn sẵn có.
 */
function hasCoordinates(
  lat: number | null | undefined,
  lng: number | null | undefined,
): boolean {
  if (lat == null || lng == null) return false;
  return !(Number(lat) === 0 && Number(lng) === 0);
}

/** Bậc phụ cấp phủ khoảng cách này; null = không bậc nào khớp. */
function matchTierAmount(
  tiers: Pick<FuelAllowanceTier, 'minDistanceKm' | 'maxDistanceKm' | 'amount'>[],
  distanceKm: number,
): number | null {
  const tier = tiers.find(
    (t) =>
      distanceKm >= Number(t.minDistanceKm) &&
      (t.maxDistanceKm == null || distanceKm <= Number(t.maxDistanceKm)),
  );
  return tier ? Number(tier.amount) : null;
}

/**
 * Chẩn đoán phụ cấp xăng của một (giáo viên công ty, điểm dạy) từ toạ độ đã
 * có sẵn — cùng quy tắc với `computeForTeacherSchool` (điểm trường có toạ độ
 * thì dùng, không thì lùi về trường; `0,0` = chưa khai; > 9999 km = sai), nhưng
 * báo ĐỦ mọi lý do thiếu thay vì dừng ở lý do đầu tiên.
 */
export function diagnoseGasAllowance(input: {
  teacher: { latitude: RawCoord; longitude: RawCoord };
  school: { latitude: RawCoord; longitude: RawCoord } | null;
  location?: { latitude: RawCoord; longitude: RawCoord } | null;
  tiers: Pick<FuelAllowanceTier, 'minDistanceKm' | 'maxDistanceKm' | 'amount'>[];
}): GasAllowanceDiagnosis {
  const reasons: GasAllowanceMissingReason[] = [];
  const toNum = (v: RawCoord) => (v == null || v === '' ? null : Number(v));

  const home = {
    lat: toNum(input.teacher.latitude),
    lng: toNum(input.teacher.longitude),
  };
  const homeOk = hasCoordinates(home.lat, home.lng);
  if (!homeOk) reasons.push('NO_TEACHER_LOCATION');

  const location = input.location
    ? { lat: toNum(input.location.latitude), lng: toNum(input.location.longitude) }
    : null;
  const school = input.school
    ? { lat: toNum(input.school.latitude), lng: toNum(input.school.longitude) }
    : null;
  const place =
    location && hasCoordinates(location.lat, location.lng)
      ? location
      : school && hasCoordinates(school.lat, school.lng)
        ? school
        : null;
  if (!place) reasons.push('NO_SCHOOL_LOCATION');

  if (!homeOk || !place) {
    return { distanceToSchoolKm: null, gasAllowance: null, missingReasons: reasons };
  }

  const distanceKm =
    Math.round(haversineKm(home.lat!, home.lng!, place.lat!, place.lng!) * 100) / 100;
  if (!Number.isFinite(distanceKm) || distanceKm > MAX_DISTANCE_KM) {
    return {
      distanceToSchoolKm: null,
      gasAllowance: null,
      missingReasons: ['INVALID_DISTANCE'],
    };
  }

  const gasAllowance = matchTierAmount(input.tiers, distanceKm);
  return {
    distanceToSchoolKm: distanceKm,
    gasAllowance,
    missingReasons: gasAllowance == null ? ['NO_MATCHING_TIER'] : [],
  };
}

/** Một lần đổi vị trí nhà đã có hiệu lực (đã duyệt/ghi nhận). */
export interface LocationChangeEntry {
  /** Ngày bắt đầu hiệu lực = ngày Nhân sự duyệt (giờ VN), 'YYYY-MM-DD'. */
  effectiveDate: string;
  latitude: RawCoord;
  longitude: RawCoord;
  previousLatitude: RawCoord;
  previousLongitude: RawCoord;
}

export interface HomePoint {
  latitude: RawCoord;
  longitude: RawCoord;
}

/**
 * Vị trí nhà của giáo viên có hiệu lực vào ngày `date`.
 *
 * Quy tắc: vị trí mới có hiệu lực TỪ NGÀY NHÂN SỰ DUYỆT — giáo viên gửi yêu
 * cầu nhiều lần trong tháng thì chỉ lần được duyệt mới tính, và tính từ ngày
 * duyệt trở đi; các ngày trước đó vẫn theo vị trí cũ.
 *
 * - Sau lần đổi cuối cùng: dùng vị trí hiện tại trong hồ sơ (nguồn sự thật
 *   cho "bây giờ", kể cả khi dữ liệu cũ bị sửa mà không để lại lịch sử).
 * - Trước lần đổi đầu tiên: dùng vị trí trước lần đổi đó; nếu đó là lần khai
 *   đầu tiên (chưa có vị trí trước) thì coi vị trí khai đầu là nơi ở từ trước.
 *
 * `changes` phải sắp tăng dần theo thời điểm duyệt.
 */
export function homeAtDate(
  changes: LocationChangeEntry[],
  current: HomePoint,
  date: string,
): HomePoint {
  if (changes.length === 0) return current;

  let appliedIndex = -1;
  for (let i = 0; i < changes.length; i += 1) {
    if (changes[i].effectiveDate <= date) appliedIndex = i;
    else break;
  }

  if (appliedIndex === changes.length - 1) return current;
  if (appliedIndex >= 0) {
    const applied = changes[appliedIndex];
    return { latitude: applied.latitude, longitude: applied.longitude };
  }

  const first = changes[0];
  if (hasCoordinates(toCoordNumber(first.previousLatitude), toCoordNumber(first.previousLongitude))) {
    return { latitude: first.previousLatitude, longitude: first.previousLongitude };
  }
  return { latitude: first.latitude, longitude: first.longitude };
}

function toCoordNumber(value: RawCoord): number | null {
  return value == null || value === '' ? null : Number(value);
}

@Injectable()
export class FuelAllowanceTierService {
  private readonly logger = new Logger(FuelAllowanceTierService.name);

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

    @InjectRepository(TeachingSession)
    private readonly sessionRepo: Repository<TeachingSession>,

    @InjectRepository(Payroll)
    private readonly payrollRepo: Repository<Payroll>,

    @InjectRepository(TeacherLocationChange)
    private readonly locationChangeRepo: Repository<TeacherLocationChange>,
  ) {}

  /**
   * Lịch sử vị trí nhà đã có hiệu lực của từng giáo viên, sắp theo thời điểm
   * duyệt — đầu vào của `homeAtDate`.
   */
  async loadLocationTimelines(
    teacherIds: number[],
  ): Promise<Map<number, LocationChangeEntry[]>> {
    const timelines = new Map<number, LocationChangeEntry[]>();
    if (teacherIds.length === 0 || !this.locationChangeRepo) return timelines;

    const changes = await this.locationChangeRepo.find({
      where: {
        teacherId: In(teacherIds),
        status: TeacherLocationChangeStatus.APPROVED,
      },
      order: { reviewedAt: 'ASC', id: 'ASC' },
    });
    for (const change of changes) {
      if (!change.reviewedAt) continue;
      const list = timelines.get(change.teacherId) ?? [];
      list.push({
        effectiveDate: vnToday(new Date(change.reviewedAt)),
        latitude: change.latitude,
        longitude: change.longitude,
        previousLatitude: change.previousLatitude,
        previousLongitude: change.previousLongitude,
      });
      timelines.set(change.teacherId, list);
    }
    return timelines;
  }

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
    const saved = await this.tierRepo.save(tier);
    // Bậc mới có thể phủ khoảng cách của các buổi đang trống phụ cấp.
    await this.recomputeMissingGasAllowancesSafely();
    return saved;
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
    const saved = await this.tierRepo.save(tier);
    // Nới khoảng cách của bậc có thể phủ thêm buổi đang trống phụ cấp. Buổi
    // đã có phụ cấp thì giữ nguyên số đã chốt.
    await this.recomputeMissingGasAllowancesSafely();
    return saved;
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
    return matchTierAmount(tiers, distanceKm);
  }

  /**
   * Điền lại phụ cấp xăng cho các buổi của giáo viên công ty đang TRỐNG
   * `gasAllowance` — phụ cấp chỉ được chốt lúc tạo buổi/gán giáo viên, nên
   * buổi tạo ra khi giáo viên chưa khai vị trí (hoặc chưa là giáo viên công
   * ty, hoặc chưa có bậc khớp) sẽ trống mãi nếu không tính lại.
   *
   * Chỉ ĐIỀN chỗ trống, không bao giờ sửa buổi đã có phụ cấp: số đã chốt là
   * lịch sử, đổi vị trí/bậc về sau không được làm lệch bảng công cũ.
   *
   * Bỏ qua tháng đã gửi phiếu lương (`PayrollStatus.SENT`) của giáo viên đó —
   * phiếu nháp thì luôn tính lại phụ cấp khi lưu nên điền vào vẫn an toàn.
   */
  async recomputeMissingGasAllowances(
    opts: { teacherId?: number } = {},
  ): Promise<RecomputeGasAllowanceResult> {
    return this.recomputeGasAllowances({ ...opts, onlyMissing: true });
  }

  /**
   * Giáo viên vừa được duyệt/ghi nhận vị trí mới: tính lại phụ cấp cho MỌI
   * buổi của họ từ ngày hiệu lực (= ngày duyệt) trở đi — kể cả buổi đã có phụ
   * cấp, vì số đó được chốt theo vị trí cũ lúc sinh buổi (có thể sinh trước
   * cả năm). Buổi trước ngày hiệu lực giữ nguyên theo vị trí cũ; tháng đã
   * gửi phiếu lương không bao giờ bị đổi.
   */
  async reapplyTeacherLocation(
    teacherId: number,
    fromDate: string,
  ): Promise<RecomputeGasAllowanceResult> {
    return this.recomputeGasAllowances({
      teacherId,
      fromDate,
      onlyMissing: false,
    });
  }

  private async recomputeGasAllowances(opts: {
    teacherId?: number;
    fromDate?: string;
    onlyMissing: boolean;
  }): Promise<RecomputeGasAllowanceResult> {
    const qb = this.sessionRepo
      .createQueryBuilder('ss')
      .innerJoin('ss.teacher', 't')
      .innerJoin('t.employee', 'e')
      .leftJoin('ss.school', 'sc')
      .leftJoin('ss.schoolLocation', 'sl')
      .select([
        'ss.id AS "id"',
        'ss.teacherId AS "teacherId"',
        't.employeeId AS "employeeId"',
        't.name AS "teacherName"',
        't.latitude AS "teacherLatitude"',
        't.longitude AS "teacherLongitude"',
        'ss.schoolId AS "schoolId"',
        'sc.name AS "schoolName"',
        'sc.latitude AS "schoolLatitude"',
        'sc.longitude AS "schoolLongitude"',
        'ss.schoolLocationId AS "schoolLocationId"',
        'sl.name AS "locationName"',
        'sl.latitude AS "locationLatitude"',
        'sl.longitude AS "locationLongitude"',
        'ss.date AS "date"',
        'ss.gasAllowance AS "gasAllowance"',
        'ss.distanceToSchoolKm AS "distanceToSchoolKm"',
      ])
      .where(':staffRole = ANY(e.roles)', { staffRole: TEACHER_STAFF_ROLE });
    if (opts.onlyMissing) qb.andWhere('ss.gasAllowance IS NULL');
    if (opts.fromDate) {
      qb.andWhere('ss.date >= :fromDate', { fromDate: opts.fromDate });
    }
    if (opts.teacherId) {
      qb.andWhere('ss.teacherId = :teacherId', { teacherId: opts.teacherId });
    }
    const rows: Record<string, any>[] = await qb.getRawMany();

    const result: RecomputeGasAllowanceResult = {
      updated: 0,
      skippedLocked: 0,
      stillMissing: 0,
      missing: buildMissingAllowanceReport([]),
    };
    if (rows.length === 0) return result;

    const employeeIds = [...new Set(rows.map((r) => Number(r.employeeId)))];
    const teacherIds = [...new Set(rows.map((r) => Number(r.teacherId)))];
    const [sentPayrolls, tiers, timelines] = await Promise.all([
      this.payrollRepo.find({
        select: { employeeId: true, year: true, month: true },
        where: { employeeId: In(employeeIds), status: PayrollStatus.SENT },
      }),
      this.findAll(),
      this.loadLocationTimelines(teacherIds),
    ]);
    const lockedKeys = new Set(
      sentPayrolls.map((p) => `${p.employeeId}-${p.year}-${p.month}`),
    );
    const periodOf = (date: string) => {
      const [year, month] = date.split('-').map(Number);
      return { year, month };
    };

    // Vị trí nhà tính theo NGÀY DẠY (có hiệu lực từ ngày duyệt), không theo
    // vị trí hiện tại — buổi trước lần đổi vẫn phải theo nhà cũ.
    // Cùng giáo viên + cùng điểm dạy + cùng vị trí nhà → một kết quả, tính một
    // lần mỗi nhóm.
    const groups = new Map<string, { home: HomePoint; rows: typeof rows }>();
    for (const row of rows) {
      const date = toDateString(row.date) as string;
      const { year, month } = periodOf(date);
      if (lockedKeys.has(`${Number(row.employeeId)}-${year}-${month}`)) {
        result.skippedLocked += 1;
        continue;
      }
      const home = homeAtDate(
        timelines.get(Number(row.teacherId)) ?? [],
        { latitude: row.teacherLatitude, longitude: row.teacherLongitude },
        date,
      );
      const key = `${row.teacherId}|${row.schoolId}|${row.schoolLocationId ?? ''}|${home.latitude},${home.longitude}`;
      const group = groups.get(key) ?? { home, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    const missingEntries: MissingAllowanceEntry[] = [];
    for (const { home, rows: group } of groups.values()) {
      const first = group[0];
      const diagnosis = diagnoseGasAllowance({
        teacher: home,
        school: { latitude: first.schoolLatitude, longitude: first.schoolLongitude },
        location:
          first.schoolLocationId != null
            ? { latitude: first.locationLatitude, longitude: first.locationLongitude }
            : null,
        tiers,
      });

      // Chỉ ghi các buổi có số thay đổi — tránh chạm `updated_at` vô ích.
      const changed = group.filter(
        (r) =>
          (r.gasAllowance == null ? null : Number(r.gasAllowance)) !==
            diagnosis.gasAllowance ||
          (r.distanceToSchoolKm == null ? null : Number(r.distanceToSchoolKm)) !==
            diagnosis.distanceToSchoolKm,
      );
      if (changed.length > 0 && (diagnosis.gasAllowance != null || !opts.onlyMissing)) {
        // Chế độ áp vị trí mới: vị trí mới không khớp bậc nào thì phụ cấp về
        // trống thật (không được giữ số của nhà cũ) — báo ở danh sách cần bổ sung.
        await this.sessionRepo.update(
          { id: In(changed.map((r) => Number(r.id))) },
          {
            distanceToSchoolKm: diagnosis.distanceToSchoolKm,
            gasAllowance: diagnosis.gasAllowance,
          },
        );
        result.updated += changed.length;
      }

      if (diagnosis.gasAllowance == null) {
        result.stillMissing += group.length;
        missingEntries.push({
          teacherId: Number(first.teacherId),
          teacherName: String(first.teacherName ?? ''),
          schoolId: Number(first.schoolId),
          schoolName: first.schoolName ?? null,
          schoolLocationId:
            first.schoolLocationId != null ? Number(first.schoolLocationId) : null,
          locationName: first.locationName ?? null,
          diagnosis,
          sessions: group.length,
        });
      }
    }

    result.missing = buildMissingAllowanceReport(missingEntries);
    return result;
  }

  /**
   * Tính lại kèm theo một thao tác khác (lưu vị trí giáo viên, sửa bậc...):
   * lỗi chỉ ghi log, không được làm hỏng thao tác chính — Nhân sự vẫn còn nút
   * tính lại thủ công ở tab Quãng đường.
   */
  /** Như `reapplyTeacherLocation` nhưng lỗi chỉ ghi log (đi kèm thao tác duyệt/lưu). */
  async reapplyTeacherLocationSafely(
    teacherId: number,
    fromDate: string,
  ): Promise<void> {
    try {
      const result = await this.reapplyTeacherLocation(teacherId, fromDate);
      if (result.updated > 0) {
        this.logger.log(
          `Áp vị trí mới của giáo viên #${teacherId} từ ${fromDate}: ` +
            `tính lại phụ cấp ${result.updated} buổi`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Không áp được vị trí mới cho giáo viên #${teacherId}: ${(error as Error).message}`,
      );
    }
  }

  async recomputeMissingGasAllowancesSafely(
    opts: { teacherId?: number } = {},
  ): Promise<void> {
    try {
      const result = await this.recomputeMissingGasAllowances(opts);
      if (result.updated > 0) {
        this.logger.log(
          `Điền phụ cấp xăng cho ${result.updated} buổi` +
            (opts.teacherId ? ` (giáo viên #${opts.teacherId})` : ''),
        );
      }
    } catch (error) {
      this.logger.error(
        `Không tính lại được phụ cấp xăng: ${(error as Error).message}`,
      );
    }
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
    if (!hasCoordinates(teacher.latitude, teacher.longitude)) {
      return { isCompanyTeacher: true, distanceToSchoolKm: null, gasAllowance: null };
    }

    const school = await this.schoolRepo.findOne({ where: { id: schoolId } });

    let lat = school?.latitude;
    let lng = school?.longitude;

    if (schoolLocationId) {
      const location = await this.locationRepo.findOne({ where: { id: schoolLocationId } });
      if (hasCoordinates(location?.latitude, location?.longitude)) {
        lat = location!.latitude;
        lng = location!.longitude;
      }
    }

    if (!hasCoordinates(lat, lng)) {
      return { isCompanyTeacher: true, distanceToSchoolKm: null, gasAllowance: null };
    }

    const distanceKm =
      Math.round(
        haversineKm(
          teacher.latitude!,
          teacher.longitude!,
          lat!,
          lng!,
        ) * 100,
      ) / 100;

    // Chốt chặn cuối: khoảng cách vô lý thì coi như chưa khai toạ độ. Cột
    // `teaching_sessions.distance_to_school_km` là numeric(6,2), nhét số lớn
    // hơn vào là Postgres ném `numeric field overflow` — mà chỗ gọi hàm này
    // (sinh buổi dạy sau khi giáo viên xác nhận lịch) nuốt lỗi vào log, nên
    // hậu quả là giáo viên mất sạch buổi dạy mà không ai được báo.
    if (!Number.isFinite(distanceKm) || distanceKm > MAX_DISTANCE_KM) {
      return { isCompanyTeacher: true, distanceToSchoolKm: null, gasAllowance: null };
    }

    const tiers = await this.findAll();
    const gasAllowance = this.resolveAmount(tiers, distanceKm);

    return { isCompanyTeacher: true, distanceToSchoolKm: distanceKm, gasAllowance };
  }
}
