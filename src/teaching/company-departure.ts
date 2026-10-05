/**
 * Giáo viên công ty dạy ở trường thuộc khu vực TP.HCM tính phụ cấp xăng theo
 * quãng đường từ VĂN PHÒNG tới trường, không phải từ nhà giáo viên (quyết định
 * 03/10/2026, áp dụng từ năm học 2026–2027). Trường ngoài khu vực vẫn tính từ nhà.
 */

/** 231 Nguyễn Phúc Chu, Tân Sơn, TP.HCM — https://maps.app.goo.gl/NU9jtALCF6ioc8uw6 */
export const HCM_OFFICE = { latitude: 10.8251303, longitude: 106.6390233 };

/** `provinces.id` của TP. Hồ Chí Minh. */
const HCM_PROVINCE_ID = 6;

/**
 * Phường/xã của Bà Rịa–Vũng Tàu và Bình Dương trước khi gộp vào TP.HCM — là vùng
 * riêng, không tính "khu vực HCM". Khớp `VUNG_TAU_WARD_IDS` / `BINH_DUONG_WARD_IDS`
 * ở kido-app (`pages/Teaching/hooks/useTeachingRefData.ts`).
 */
const FORMER_PROVINCE_WARD_IDS = new Set([
  // Vũng Tàu
  7, 18, 24, 66, 79, 117, 151, 179, 439, 461,
  // Bình Dương
  68, 84, 91, 93, 95, 99, 146, 185, 188, 437, 450, 459,
]);

type RawId = number | string | null | undefined;
type RawCoord = number | string | null | undefined;

/** Trường (qua phường/xã của trường) thuộc khu vực TP.HCM. */
export function isHcmRegionWard(wardId: RawId, provinceId: RawId): boolean {
  if (wardId == null || provinceId == null) return false;
  return (
    Number(provinceId) === HCM_PROVINCE_ID &&
    !FORMER_PROVINCE_WARD_IDS.has(Number(wardId))
  );
}

/** Điều kiện SQL "trường khu vực HCM" theo alias bảng phường/xã của trường. */
export const HCM_REGION_SQL = (wardAlias: string) =>
  `(${wardAlias}.province_id = ${HCM_PROVINCE_ID} AND ${wardAlias}.id NOT IN (${[
    ...FORMER_PROVINCE_WARD_IDS,
  ].join(', ')}))`;

/** Điểm xuất phát tính phụ cấp: văn phòng nếu trường ở khu vực HCM, không thì nhà. */
export function departurePoint<
  T extends { latitude: RawCoord; longitude: RawCoord },
>(
  home: T,
  school: { wardId: RawId; provinceId: RawId },
): T | typeof HCM_OFFICE {
  return isHcmRegionWard(school.wardId, school.provinceId) ? HCM_OFFICE : home;
}
