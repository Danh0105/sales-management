import { haversineKm } from './teacher-matching.service';
import { buildTravelBlocks, TravelSessionRow } from './teacher-travel.util';

const COORDS: Record<string, { lat: number; lng: number }> = {
  S10: { lat: 10.77, lng: 106.7 },
  S20: { lat: 10.8, lng: 106.65 },
  L3: { lat: 10.75, lng: 106.68 },
};

const coordsOf = (row: TravelSessionRow) =>
  COORDS[
    row.schoolLocationId
      ? `L${row.schoolLocationId}`
      : `S${row.schoolId}`
  ] ?? null;

const row = (overrides: Partial<TravelSessionRow>): TravelSessionRow => ({
  teacherId: 8,
  schoolId: 10,
  schoolLocationId: null,
  date: '2026-08-05',
  gasAllowance: '20000',
  distanceToSchoolKm: '5',
  ...overrides,
});

describe('buildTravelBlocks', () => {
  it('gộp tiết liên tiếp cùng điểm thành 1 lượt, chặng đầu ngày lấy km nhà -> trường', () => {
    const blocks = buildTravelBlocks([row({}), row({})], coordsOf);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      counted: true,
      gasAllowance: 20000,
      distanceKm: 5,
      distanceSource: 'home',
    });
    expect(blocks[0].rows).toHaveLength(2);
  });

  it('lượt thứ 2 trong ngày tính km từ điểm trường trước', () => {
    const blocks = buildTravelBlocks(
      [row({}), row({ schoolId: 20, gasAllowance: '30000', distanceToSchoolKm: '9' })],
      coordsOf,
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[1].distanceSource).toBe('previous_place');
    // Km S10 -> S20, không phải 9 km nhà -> S20.
    const expected =
      Math.round(
        haversineKm(COORDS.S10.lat, COORDS.S10.lng, COORDS.S20.lat, COORDS.S20.lng) * 100,
      ) / 100;
    expect(blocks[1].distanceKm).toBe(expected);
    expect(blocks[1].distanceKm).not.toBe(9);
  });

  it('cơ sở khác nhau của cùng trường là 2 lượt', () => {
    const blocks = buildTravelBlocks(
      [row({}), row({ schoolLocationId: 3 })],
      coordsOf,
    );

    expect(blocks.map((b) => b.placeKey)).toEqual(['S10', 'L3']);
  });

  it('sang ngày mới thì quay lại km nhà -> trường', () => {
    const blocks = buildTravelBlocks(
      [row({}), row({ date: '2026-08-06', schoolId: 20, distanceToSchoolKm: '9' })],
      coordsOf,
    );

    expect(blocks[1]).toMatchObject({ distanceKm: 9, distanceSource: 'home' });
  });

  it('buổi không có phụ cấp hiện riêng, không làm lệch chặng liên trường', () => {
    const blocks = buildTravelBlocks(
      [
        row({}),
        row({ schoolLocationId: 3, gasAllowance: null, distanceToSchoolKm: null }),
        row({ schoolId: 20, gasAllowance: '30000' }),
      ],
      coordsOf,
    );

    expect(blocks.map((b) => b.counted)).toEqual([true, false, true]);
    expect(blocks[1]).toMatchObject({ gasAllowance: null, distanceKm: null });
    // Chặng S10 -> S20, bỏ qua điểm L3 không được tính tiền.
    const direct = buildTravelBlocks(
      [row({}), row({ schoolId: 20, gasAllowance: '30000' })],
      coordsOf,
    );
    expect(blocks[2].distanceKm).toBe(direct[1].distanceKm);
  });

  it('thiếu toạ độ và thiếu km nhà -> trường thì chặng không có km', () => {
    const blocks = buildTravelBlocks(
      [row({ schoolId: 99, distanceToSchoolKm: null })],
      coordsOf,
    );

    expect(blocks[0]).toMatchObject({ distanceKm: null, distanceSource: null });
  });
});
