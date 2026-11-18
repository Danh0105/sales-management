import { In, type EntityManager } from 'typeorm';

import { SchoolExpenseManagementConfirmation } from './entities/school-expense-management-confirmation.entity';

/** Xác nhận đúng BBCS của các môn trong một (hoặc nhiều) bảng thu chi. */
export async function loadManagementConfirmations(
  manager: EntityManager,
  schoolExpenseIds: number[],
) {
  const ids = [...new Set(schoolExpenseIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) return [];
  return manager.getRepository(SchoolExpenseManagementConfirmation).find({
    where: { schoolExpenseId: In(ids) },
    order: { schoolExpenseId: 'ASC', subjectId: 'ASC' },
  });
}

/** Bảng Chi Ngoài của môn này trong bảng thu chi đã "Xác nhận đúng BBCS" chưa. */
export async function isManagementConfirmed(
  manager: EntityManager,
  schoolExpenseId: number,
  subjectId: number | null | undefined,
) {
  if (!subjectId) return false;
  return manager
    .getRepository(SchoolExpenseManagementConfirmation)
    .exists({ where: { schoolExpenseId, subjectId: Number(subjectId) } });
}

/** Dạng trả về cho màn hình. */
export const confirmationView = (row: SchoolExpenseManagementConfirmation) => ({
  subjectId: row.subjectId,
  confirmedBy: row.confirmedBy,
  confirmedByName: row.confirmedByName,
  confirmedAt: row.confirmedAt,
});
