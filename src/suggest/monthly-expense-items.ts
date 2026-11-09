import { BadRequestException } from '@nestjs/common';

import type { ExpensePeriod } from '../expense-periods/expense-period.entity';
import type { School } from '../school/schools.entity';
import type { Subject } from '../subject/subject.entity';
import type { ManagementViewSection } from './expense-management-view';

/** Một trường của đề xuất chi tháng như người dùng gửi lên (chưa kiểm). */
export interface MonthlyItemInput {
  schoolId?: number | null;
  schoolYear?: string | null;
  subjectId?: number | null;
  expensePeriodId?: number | null;
}

/** Một trường của đề xuất chi tháng đã kiểm xong. */
export interface ResolvedMonthlyItem {
  school: School;
  schoolYear: string;
  subject: Subject;
  expensePeriod: ExpensePeriod;
}

/**
 * Client cũ và đề xuất tạo trước khi chọn được nhiều trường chỉ có một trường,
 * nằm ở các cột đơn `schoolId/schoolYear/subjectId/expensePeriodId`.
 */
export function monthlyItemsFromColumns(source: MonthlyItemInput): MonthlyItemInput[] {
  if (source.schoolId === undefined || source.schoolId === null) return [];
  return [
    {
      schoolId: source.schoolId,
      schoolYear: source.schoolYear ?? null,
      subjectId: source.subjectId ?? null,
      expensePeriodId: source.expensePeriodId ?? null,
    },
  ];
}

/**
 * Số tiền lệnh chi của đề xuất chi tháng = tổng dòng "Còn chi" của mọi bảng
 * Chi Ngoài Giám đốc thấy khi duyệt. Làm tròn đồng để khớp cột numeric(18,2).
 */
export function monthlyRemainingTotal(sections: ManagementViewSection[]): number {
  const total = sections.reduce(
    (sum, section) => sum + (Number(section.totals?.remaining) || 0),
    0,
  );
  return Math.round(total * 100) / 100;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Khoá của một dòng trường: bảng Chi Ngoài khớp theo trường + môn + kỳ. */
export interface MonthlyItemKey {
  schoolId: number | null;
  subjectId: number | null;
  expensePeriodId: number | null;
}

/**
 * Phần của từng dòng trong lệnh chi = Còn chi của đúng các bảng Chi Ngoài
 * thuộc dòng đó, lấy từ cùng bảng đã dùng để lập lệnh chi (tổng các dòng bằng
 * số tiền lệnh chi vì môn + kỳ không trùng giữa các dòng).
 */
export function monthlyItemAmounts(
  items: MonthlyItemKey[],
  sections: ManagementViewSection[],
): number[] {
  return items.map((item) =>
    round2(
      sections
        .filter(
          (section) =>
            section.schoolId === item.schoolId &&
            section.subjectId === item.subjectId &&
            section.periodId === item.expensePeriodId,
        )
        .reduce((sum, section) => sum + (Number(section.totals?.remaining) || 0), 0),
    ),
  );
}

/**
 * Giám đốc chọn dòng duyệt. Bỏ trống = duyệt tất cả. Trả tập id được duyệt
 * và số tiền lệnh chi = tổng phần của các dòng đó.
 */
export function selectApprovedItems(
  items: { id: number }[],
  amounts: number[],
  approvedItemIds?: number[],
): { approvedIds: Set<number>; total: number } {
  const known = new Set(items.map((item) => item.id));
  const approvedIds = new Set(approvedItemIds ?? items.map((item) => item.id));
  if (approvedItemIds) {
    if (approvedIds.size === 0) {
      throw new BadRequestException('Phải duyệt ít nhất một trường');
    }
    if (approvedIds.size !== approvedItemIds.length) {
      throw new BadRequestException('Chọn trùng trường');
    }
    if ([...approvedIds].some((id) => !known.has(id))) {
      throw new BadRequestException('Trường đã chọn không thuộc đề xuất này');
    }
  }
  const total = round2(
    items.reduce(
      (sum, item, index) => (approvedIds.has(item.id) ? sum + amounts[index] : sum),
      0,
    ),
  );
  return { approvedIds, total };
}

export interface PartialSpendItem {
  id: number;
  approvedAmount: number | null;
}

/**
 * Chi một phần: kinh doanh chỉ chọn trường đã chi, không nhập số. Số đã chi
 * = tổng phần của các trường đó lúc Giám đốc duyệt, phần dư = lệnh chi − số
 * đã chi. Ném lỗi (tiếng Việt) khi không chia được hoặc chọn không hợp lệ.
 */
export function partialSpendSummary(
  items: PartialSpendItem[],
  orderAmount: number,
  spentItemIds: number[],
): { spentAmount: number; returnAmount: number } {
  if (items.length < 2) {
    throw new BadRequestException(
      'Đề xuất chỉ có một trường — chọn "Đã chi" hoặc "Chưa chi"',
    );
  }
  if (items.some((item) => item.approvedAmount === null || item.approvedAmount === undefined)) {
    throw new BadRequestException(
      'Lệnh chi do Kế toán lập nên không chia được theo trường — chọn "Đã chi" hoặc "Chưa chi"',
    );
  }
  const total = round2(items.reduce((sum, item) => sum + Number(item.approvedAmount), 0));
  if (Math.abs(total - round2(orderAmount)) >= 0.01) {
    throw new BadRequestException(
      'Số tiền lệnh chi đã đổi sau khi Giám đốc duyệt nên không chia được theo trường — chọn "Đã chi" hoặc "Chưa chi"',
    );
  }
  const chosen = new Set(spentItemIds);
  if (chosen.size === 0) {
    throw new BadRequestException('Chọn ít nhất một trường đã chi');
  }
  if (chosen.size !== spentItemIds.length) {
    throw new BadRequestException('Chọn trùng trường');
  }
  const known = new Set(items.map((item) => item.id));
  if ([...chosen].some((id) => !known.has(id))) {
    throw new BadRequestException('Trường đã chọn không thuộc đề xuất này');
  }
  if (chosen.size === items.length) {
    throw new BadRequestException('Đã chi tất cả các trường — chọn "Đã chi"');
  }
  const spentAmount = round2(
    items
      .filter((item) => chosen.has(item.id))
      .reduce((sum, item) => sum + Number(item.approvedAmount), 0),
  );
  const returnAmount = round2(round2(orderAmount) - spentAmount);
  if (!(spentAmount > 0)) {
    throw new BadRequestException(
      'Các trường đã chọn không có tiền chi — chọn "Chưa chi" để hoàn toàn bộ',
    );
  }
  if (!(returnAmount > 0)) {
    throw new BadRequestException(
      'Các trường không chi không có tiền để hoàn — chọn "Đã chi"',
    );
  }
  return { spentAmount, returnAmount };
}

/** Nhãn một dòng trường cho lịch sử: "TH A · Tin học · Tháng 9/2026". */
export function monthlyItemLabel(item: {
  schoolId?: number | null;
  school?: { name?: string | null } | null;
  subject?: { name?: string | null; catalog?: { name?: string | null } | null } | null;
  expensePeriod?: { name?: string | null; month?: number; year?: number } | null;
}): string {
  const period = item.expensePeriod
    ? item.expensePeriod.name ||
      `Tháng ${item.expensePeriod.month}/${item.expensePeriod.year}`
    : null;
  return [
    item.school?.name || `Trường #${item.schoolId ?? '?'}`,
    item.subject?.catalog?.name || item.subject?.name,
    period,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "1.300.000" — số tiền trong thông báo (bỏ phần lẻ ,00). */
export const formatMoneyVnd = (value: number) =>
  Math.round(value).toLocaleString('vi-VN');
