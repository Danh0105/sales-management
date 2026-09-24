import { haversineKm } from './teacher-matching.service';

export interface LatLngPoint {
  lat: number;
  lng: number;
}

/** Tối thiểu một buổi dạy cần có để dựng lộ trình di chuyển. */
export interface TravelSessionRow {
  teacherId: number | string;
  schoolId: number | string;
  schoolLocationId: number | string | null;
  /** Đã chuẩn hoá về 'YYYY-MM-DD'. */
  date: string;
  gasAllowance: number | string | null;
  distanceToSchoolKm: number | string | null;
}

/**
 * Nguồn của số km một chặng:
 * - `home`: chặng đầu ngày — khoảng cách nhà -> trường đã chốt trên buổi dạy.
 * - `previous_place`: chặng liên trường — điểm trường trước -> điểm trường này.
 * - `null`: không xác định được (thiếu toạ độ).
 */
export type TravelDistanceSource = 'home' | 'previous_place' | null;

/**
 * Một lượt đến nơi dạy: chuỗi tiết liên tiếp trong cùng ngày, cùng giáo viên,
 * cùng địa điểm (cơ sở nếu có, không thì trường).
 */
export interface TravelBlock<R extends TravelSessionRow> {
  teacherId: number;
  date: string;
  placeKey: string;
  rows: R[];
  coords: LatLngPoint | null;
  /**
   * `true` = lượt này được trả phụ cấp xăng (buổi có `gasAllowance`) và nằm
   * trong lộ trình tính km. `false` = giáo viên công ty nhưng buổi không chốt
   * được phụ cấp (thiếu vị trí/toạ độ trường/chưa khai bậc) — chỉ hiện ra để
   * rà soát, không ảnh hưởng tiền hay km.
   */
  counted: boolean;
  gasAllowance: number | null;
  distanceKm: number | null;
  distanceSource: TravelDistanceSource;
}

/** Tiền tố L/S bắt buộc: id cơ sở và id trường đánh số độc lập. */
export const travelPlaceKey = (row: TravelSessionRow): string =>
  row.schoolLocationId
    ? `L${Number(row.schoolLocationId)}`
    : `S${Number(row.schoolId)}`;

const roundKm = (km: number) => Math.round(km * 100) / 100;

/**
 * Gom các buổi dạy (đã sắp theo giáo viên, ngày, giờ bắt đầu) thành các lượt
 * đi lại, kèm số km của từng chặng.
 *
 * Đây là nguồn duy nhất cho cả bảng công (tổng phụ cấp xăng + tổng km) lẫn màn
 * rà soát quãng đường — hai nơi phải ra đúng cùng một con số.
 *
 * Quy tắc km:
 * - Lượt đầu ngày dùng `distanceToSchoolKm` (nhà -> trường) đã chốt trên buổi.
 * - Lượt sau trong cùng ngày tính điểm trường trước -> điểm trường này, đúng
 *   lộ trình thật thay vì (nhà->A)+(nhà->B).
 * - Chưa tính chặng về nhà cuối ngày.
 *
 * Khoản TIỀN phụ cấp vẫn theo bậc nhà->trường của từng lượt (chốt sẵn trên
 * buổi dạy) — số km liên trường chỉ để đối chiếu, không đổi tiền.
 */
export function buildTravelBlocks<R extends TravelSessionRow>(
  rows: R[],
  coordsOf: (row: R) => LatLngPoint | null,
): TravelBlock<R>[] {
  const blocks: TravelBlock<R>[] = [];

  // Trạng thái của chuỗi lượt được tính tiền.
  let prevTeacherId: number | null = null;
  let prevDate: string | null = null;
  let prevPlaceKey: string | null = null;
  let prevPlaceCoords: LatLngPoint | null = null;
  let currentCounted: TravelBlock<R> | null = null;

  // Lượt không được tính tiền đi chuỗi riêng — không được xen vào làm lệch
  // điểm xuất phát của chặng liên trường kế tiếp.
  let currentUncounted: TravelBlock<R> | null = null;

  for (const row of rows) {
    const teacherId = Number(row.teacherId);
    const date = row.date;
    const placeKey = travelPlaceKey(row);

    if (row.gasAllowance == null) {
      const sameBlock =
        currentUncounted &&
        currentUncounted.teacherId === teacherId &&
        currentUncounted.date === date &&
        currentUncounted.placeKey === placeKey;
      if (sameBlock) {
        currentUncounted!.rows.push(row);
      } else {
        currentUncounted = {
          teacherId,
          date,
          placeKey,
          rows: [row],
          coords: coordsOf(row),
          counted: false,
          gasAllowance: null,
          distanceKm: null,
          distanceSource: null,
        };
        blocks.push(currentUncounted);
      }
      continue;
    }

    const isNewDay = teacherId !== prevTeacherId || date !== prevDate;
    const isNewBlock = isNewDay || placeKey !== prevPlaceKey;

    if (isNewBlock) {
      const coords = coordsOf(row);
      let distanceKm: number | null =
        row.distanceToSchoolKm != null ? Number(row.distanceToSchoolKm) : null;
      let distanceSource: TravelDistanceSource =
        distanceKm != null ? 'home' : null;

      if (!isNewDay && prevPlaceCoords && coords) {
        distanceKm = roundKm(
          haversineKm(prevPlaceCoords.lat, prevPlaceCoords.lng, coords.lat, coords.lng),
        );
        distanceSource = 'previous_place';
      }

      currentCounted = {
        teacherId,
        date,
        placeKey,
        rows: [row],
        coords,
        counted: true,
        gasAllowance: Number(row.gasAllowance),
        distanceKm,
        distanceSource,
      };
      blocks.push(currentCounted);
      prevPlaceCoords = coords;
    } else {
      currentCounted!.rows.push(row);
    }

    prevTeacherId = teacherId;
    prevDate = date;
    prevPlaceKey = placeKey;
  }

  return blocks;
}
