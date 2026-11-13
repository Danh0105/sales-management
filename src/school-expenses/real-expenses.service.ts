import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import {
  DataSource,
  EntityManager,
  EntityTarget,
  In,
  Not,
  ObjectLiteral,
  Repository,
} from 'typeorm';

import { School } from '../school/schools.entity';

import { ExpensePeriod } from '../expense-periods/expense-period.entity';

import { SchoolExpense } from './entities/school-expenses.entity';
import { SchoolExpenseHistory } from './entities/school-expense-history.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { ManagementExpenseOtherCost } from '../management-expense-item/management-expense-other-cost.entity';
import { Subject } from '../subject/subject.entity';
import {
  assertNotFinalized,
  buildManagementExpenseItemData,
  assertManagementPaidWithinOutside,
  buildLockedManagementRowData,
  buildManagementPaymentData,
  buildStandaloneContentData,
  pickLockedManagementRows,
  recomputeManagementOutside,
  buildPaymentDateSourceData,
  buildRevenueItemData,
  buildSchoolExpenseItemData,
  canEditLockedDateSource,
  canEditLockedManagementPayments,
  computeOtherCostRows,
  normalizeSharedFields,
} from './expense-calculations';
import { AuthUser } from '../type/auth-user.type';
import { SchoolExpenseManagementConfirmation } from './entities/school-expense-management-confirmation.entity';
import {
  confirmationView,
  isManagementConfirmed,
  loadManagementConfirmations,
} from './management-confirmations';
import { SchoolTeacherExpenseItem } from '../school-teacher-expense/school-teacher-expense-item.entity';
import { SchoolTeacherPayrollApproval } from '../school-teacher-expense/school-teacher-payroll-approval.entity';
import { SchoolTeacher } from '../school-teacher-expense/school-teacher.entity';
import {
  allocateSchoolTeacherTax,
  buildSchoolTeacherItemData,
  buildSchoolTeacherPaymentData,
  SCHOOL_TEACHER_SPLIT_FROM,
  schoolTeacherMoneySignature,
  schoolTeacherPaid,
  schoolTeacherSplitApplies,
} from '../school-teacher-expense/school-teacher';
import {
  assertLinkedRowsKept,
  keepLinkedPaymentFields,
  LinkedManagementRow,
  loadLinkedManagementRows,
  loadLinkedTeacherRows,
  loadSuggestPayments,
  linkedRowDeleteError,
  suggestCodesLabel,
  withSuggestPayments,
} from '../management-expense-item/suggest-payments';

/**
 * Ghi một nhóm cột lên các dòng cũ, khớp theo `id` client gửi kèm (không theo
 * vị trí) — xoá / thêm dòng ở client không làm ghi nhầm sang dòng khác; dòng
 * không khớp id (hoặc `build` trả null) thì bỏ qua. Trả về snapshot cho lịch sử.
 */
async function updateRowsById<R extends { id: number; rowIndex: number }>(
  manager: EntityManager,
  entity: EntityTarget<ObjectLiteral>,
  oldRows: R[],
  items: unknown,
  build: (item: any, old: R) => ObjectLiteral | null,
) {
  const byId = new Map<number, any>(
    (Array.isArray(items) ? items : [])
      .filter((item: any) => item?.id)
      .map((item: any) => [Number(item.id), item]),
  );
  const snapshot: ObjectLiteral[] = [];

  for (const old of oldRows) {
    const item = byId.get(old.id);
    if (!item) continue;

    const data = build(item, old);
    if (!data) continue;
    await manager.update(entity, { id: old.id }, data);
    snapshot.push({ rowIndex: old.rowIndex, ...data });
  }

  return snapshot;
}

@Injectable()
export class RealExpensesService {
  constructor(
    @InjectRepository(SchoolExpense)
    private readonly schoolExpenseRepository: Repository<SchoolExpense>,

    @InjectRepository(School)
    private readonly schoolRepository: Repository<School>,

    @InjectRepository(ExpensePeriod)
    private readonly expensePeriodRepository: Repository<ExpensePeriod>,

    @InjectRepository(RevenueItem)
    private readonly revenueItemRepository: Repository<RevenueItem>,

    @InjectRepository(SchoolExpenseItem)
    private readonly schoolExpenseItemRepository: Repository<SchoolExpenseItem>,

    @InjectRepository(ManagementExpenseItem)
    private readonly managementExpenseItemRepository: Repository<ManagementExpenseItem>,

    @InjectRepository(Subject)
    private readonly subjectRepository: Repository<Subject>,

    @InjectRepository(SchoolExpenseHistory)
    private readonly historyRepository: Repository<SchoolExpenseHistory>,

    private readonly dataSource: DataSource,
  ) {}

  // CREATE
  async create(body: any, user?: AuthUser) {
    const school = await this.schoolRepository.findOne({
      where: {
        id: body.schoolId,
      },
    });

    if (!school) {
      throw new NotFoundException('School not found');
    }

    const period = await this.expensePeriodRepository.findOne({
      where: {
        id: body.periodId,
      },
    });

    if (!period) {
      throw new NotFoundException('ExpensePeriod not found');
    }

    // CHECK DUPLICATE
    const existed = await this.schoolExpenseRepository.findOne({
      where: {
        school: {
          id: body.schoolId,
        },

        period: {
          id: body.periodId,
        },
      },

      relations: ['school', 'period'],
    });

    if (existed) {
      throw new BadRequestException(
        'School expense already exists in this period',
      );
    }

    const entity = this.schoolExpenseRepository.create({
      school,

      period,

      totalRevenue: 0,

      totalExpense: 0,

      totalCashPolicy: 0,
    });

    const saved = await this.schoolExpenseRepository.save(entity);

    await this.historyRepository.save({
      schoolExpenseId: saved.id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'CREATE',
      entityType: 'school_expense',
      newData: { schoolId: body.schoolId, periodId: body.periodId },
    });

    return saved;
  }

  // FIND ALL
  async findAll(query: any) {
    const qb = this.schoolExpenseRepository
      .createQueryBuilder('schoolExpense')
      .leftJoinAndSelect('schoolExpense.school', 'school')
      .leftJoinAndSelect('schoolExpense.period', 'period')
      .leftJoinAndSelect('schoolExpense.expenseItems', 'expenseItems')
      .leftJoinAndSelect('schoolExpense.cashPolicyItems', 'cashPolicyItems')
      .orderBy('schoolExpense.id', 'DESC');

    if (query.schoolId) {
      qb.andWhere('school.id = :schoolId', {
        schoolId: query.schoolId,
      });
    }

    if (query.periodId) {
      qb.andWhere('period.id = :periodId', {
        periodId: query.periodId,
      });
    }

    return await qb.getMany();
  }

  // FIND ONE
  async findOne(id: number) {
    const data = await this.schoolExpenseRepository.findOne({
      where: {
        id,
      },

      relations: [
        'school',
        'period',

        'expenseItems',
        'expenseItems.subject',

        'cashPolicyItems',

        'managementExpenseItems',
        'managementExpenseItems.subject',
        'managementExpenseItems.otherCosts',
      ],
    });

    if (!data) {
      throw new NotFoundException('SchoolExpense not found');
    }

    // Populate otherCosts + totalOtherCostAmount cho từng dòng chi ngoài.
    if (Array.isArray(data.managementExpenseItems)) {
      (data as any).managementExpenseItems = data.managementExpenseItems.map(
        (i) => this.withOtherCosts(i),
      );
    }

    // Xác nhận đúng BBCS theo từng môn.
    (data as any).managementConfirmations = (
      await loadManagementConfirmations(this.dataSource.manager, [data.id])
    ).map(confirmationView);

    return data;
  }

  async getHistory(id: number) {
    if (!Number.isFinite(id)) {
      throw new BadRequestException('Invalid schoolExpense id');
    }

    const existed = await this.schoolExpenseRepository.exists({
      where: {
        id,
      },
    });

    if (!existed) {
      throw new NotFoundException('SchoolExpense not found');
    }

    return await this.historyRepository.find({
      where: {
        schoolExpenseId: id,
      },
      order: {
        createdAt: 'DESC',
        id: 'DESC',
      },
    });
  }

  // UPDATE
  async update(id: number, body: any, user?: AuthUser) {
    const data = await this.findOne(id);
    assertNotFinalized(data);
    const oldData = { ...data };

    if (body.schoolId) {
      const school = await this.schoolRepository.findOne({
        where: {
          id: body.schoolId,
        },
      });

      if (!school) {
        throw new NotFoundException('School not found');
      }

      data.school = school;
    }

    if (body.periodId) {
      const period = await this.expensePeriodRepository.findOne({
        where: {
          id: body.periodId,
        },
      });

      if (!period) {
        throw new NotFoundException('ExpensePeriod not found');
      }

      data.period = period;
    }

    if (body.totalRevenue !== undefined) {
      data.totalRevenue = body.totalRevenue;
    }

    if (body.totalExpense !== undefined) {
      data.totalExpense = body.totalExpense;
    }

    if (body.totalCashPolicy !== undefined) {
      data.totalCashPolicy = body.totalCashPolicy;
    }

    const saved = await this.schoolExpenseRepository.save(data);

    await this.historyRepository.save({
      schoolExpenseId: id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'UPDATE',
      entityType: 'school_expense',
      oldData: {
        totalRevenue: oldData.totalRevenue,
        totalExpense: oldData.totalExpense,
        totalCashPolicy: oldData.totalCashPolicy,
      },
      newData: body,
    });

    return saved;
  }

  // DELETE
  async remove(id: number, user?: AuthUser) {
    const data = await this.findOne(id);
    assertNotFinalized(data);

    await this.historyRepository.save({
      schoolExpenseId: id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'DELETE',
      entityType: 'school_expense',
      oldData: { id: data.id },
    });

    await this.schoolExpenseRepository.remove(data);

    return {
      message: 'Deleted successfully',
    };
  }

  async checkExisted(schoolId: number, periodId: number) {
    console.log('checkExisted', schoolId, periodId);
    if (isNaN(schoolId) || isNaN(periodId)) {
      throw new BadRequestException('Invalid params');
    }

    const existed = await this.schoolExpenseRepository.findOne({
      where: {
        school: {
          id: schoolId,
        },

        period: {
          id: periodId,
        },
      },
    });

    return existed;
  }

  // SAVE ALL
  async saveAll(schoolExpenseId: number, body: any, user?: AuthUser) {
    const schoolExpense = await this.schoolExpenseRepository.findOne({
      where: {
        id: schoolExpenseId,
      },
      relations: {
        school: true,
        period: true,
      },
    });

    if (!schoolExpense) {
      throw new NotFoundException('SchoolExpense not found');
    }

    // Từ kỳ 11/2026: Giáo viên trường tách khỏi Chi Trường sang bảng riêng —
    // khi client gửi kèm bảng Giáo viên trường, hoặc môn đã có bảng đó. Màn hình
    // bản cũ (chưa có bảng) lưu môn chưa có bảng thì Chi Trường giữ cách tính cũ
    // để không mất tiền giáo viên; môn đã có bảng thì không tính hai lần.
    const sendsSchoolTeacher = Array.isArray(body.schoolTeacherItems);
    const teacherSplit =
      schoolTeacherSplitApplies(schoolExpense.period) &&
      (sendsSchoolTeacher ||
        (await this.dataSource.getRepository(SchoolTeacherExpenseItem).count({
          where: { schoolExpenseId, subjectId: body.subjectId },
        })) > 0);

    // Kỳ đã "Kết thúc": khoá hết, trừ Ngày chi + Nguồn chi (xem
    // saveFinalizedDateSource) — sales admin vẫn bị chặn hẳn.
    const finalizedDateSourceOnly =
      schoolExpense.finalized && canEditLockedDateSource(user?.roles);
    if (!finalizedDateSourceOnly) assertNotFinalized(schoolExpense);

    const subject = await this.subjectRepository.findOne({
      where: {
        id: body.subjectId,
      },
    });

    if (!subject) {
      throw new NotFoundException('Subject not found');
    }

    if (subject.schoolId !== schoolExpense.school?.id) {
      throw new BadRequestException('Subject does not belong to school');
    }

    const where = {
      schoolExpense: { id: schoolExpenseId },
      subject: { id: body.subjectId },
    };

    const [oldRevenue, oldSchoolExpense, oldManagement] = await Promise.all([
      this.revenueItemRepository.find({ where }),
      this.schoolExpenseItemRepository.find({ where }),
      this.managementExpenseItemRepository.find({
        where,
        relations: { otherCosts: true },
      }),
    ]);

    // Dòng Chi Ngoài có tiền từ đề xuất chi: 3 ô Ngày chi / Nguồn chi / Đã chi
    // khoá, dòng không xoá được. Đọc lại trong transaction trước khi ghi.
    const linkedBefore = await loadLinkedManagementRows(this.dataSource.manager, {
      schoolExpenseId,
      subjectId: body.subjectId,
    });
    // Như Chi Ngoài: dòng Chi Trường có Đã chi từ Đề xuất Chi Trường.
    const linkedSchoolBefore = await loadLinkedManagementRows(
      this.dataSource.manager,
      { schoolExpenseId, subjectId: body.subjectId },
      'SCHOOL_EXPENSE',
    );

    if (finalizedDateSourceOnly) {
      await this.saveFinalizedDateSource(
        schoolExpenseId,
        body,
        user,
        oldSchoolExpense,
        oldManagement,
        teacherSplit && sendsSchoolTeacher,
      );
      return await this.getItems(schoolExpenseId, body.subjectId);
    }

    // Map "Chi khác" cũ theo rowIndex — dùng khi client KHÔNG gửi `otherCosts`
    // (giữ nguyên dữ liệu cũ để tương thích client cũ).
    const oldOtherCostsByRow = new Map<number, any[]>();
    for (const item of oldManagement) {
      oldOtherCostsByRow.set(
        item.rowIndex,
        (item.otherCosts ?? []).map((oc) => ({
          policyOtherCostId: oc.policyOtherCostId,
          name: oc.name,
          unitPrice: oc.unitPrice,
          tax: oc.tax,
        })),
      );
    }

    // Bảng "Chi Ngoài" đã được sales admin xác nhận → khoá, chỉ kế toán
    // trưởng còn sửa được toàn bộ. Khoá thì bỏ qua phần managementExpenseItems
    // của body (giữ nguyên dòng cũ), không ảnh hưởng tới doanh thu/chi trường.
    const isChiefAccountant = (user?.roles ?? []).includes('ketoan_truong');
    // Xác nhận đúng BBCS theo từng môn (trước 12/11/2026 cờ ở cả bảng thu chi).
    const managementLocked =
      (await isManagementConfirmed(
        this.dataSource.manager,
        schoolExpenseId,
        body.subjectId,
      )) && !isChiefAccountant;
    // Kế toán / KT công nợ / thủ quỹ: khoá rồi vẫn cập nhật cột chi của các
    // dòng cũ (Ngày chi, Nguồn chi, Đã chi, Người chi, Ghi chú).
    const managementPaymentOnly =
      managementLocked && canEditLockedManagementPayments(user?.roles);
    // Trợ lý GĐ / giám đốc: khoá rồi chỉ còn Ngày chi + Nguồn chi.
    const managementDateSourceOnly =
      managementLocked &&
      !managementPaymentOnly &&
      canEditLockedDateSource(user?.roles);

    // Doanh thu đã "Xuất hóa đơn" → khóa: không được thêm dòng, không tự mở khóa.
    // Kế toán trưởng được bỏ qua (mở khóa / thêm dòng).
    const lockedRevenueRows = new Set(
      oldRevenue
        .filter((item) => item.invoiceLocked)
        .map((item) => item.rowIndex),
    );
    const revenueLocked = !isChiefAccountant && lockedRevenueRows.size > 0;

    if (
      revenueLocked &&
      Array.isArray(body.revenueItems) &&
      body.revenueItems.length > oldRevenue.length
    ) {
      throw new BadRequestException(
        'Đã xuất hóa đơn — không thể thêm dòng doanh thu',
      );
    }

    const lockedManagementRows = managementPaymentOnly
      ? pickLockedManagementRows(body.managementExpenseItems)
      : [];

    if (!managementLocked) assertLinkedRowsKept(linkedBefore, body.managementExpenseItems);
    assertLinkedRowsKept(linkedSchoolBefore, body.schoolExpenseItems, 'SCHOOL_EXPENSE');

    if (managementPaymentOnly) {
      assertManagementPaidWithinOutside(
        this.lockedPaidTotals(oldManagement, body, lockedManagementRows, linkedBefore),
      );
    } else if (!managementLocked) {
      assertManagementPaidWithinOutside(
        this.submittedPaidTotals(oldManagement, body, oldOtherCostsByRow, linkedBefore),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Cùng khoá với bước kinh doanh xác nhận đã chi (ghi Đã chi vào Chi Ngoài).
      await queryRunner.manager.query(
        `SELECT id FROM school_expenses WHERE id = $1 FOR UPDATE`,
        [schoolExpenseId],
      );
      const linked = await loadLinkedManagementRows(queryRunner.manager, {
        schoolExpenseId,
        subjectId: body.subjectId,
      });
      if (!managementLocked) assertLinkedRowsKept(linked, body.managementExpenseItems);
      const linkedSchool = await loadLinkedManagementRows(
        queryRunner.manager,
        { schoolExpenseId, subjectId: body.subjectId },
        'SCHOOL_EXPENSE',
      );
      assertLinkedRowsKept(linkedSchool, body.schoolExpenseItems, 'SCHOOL_EXPENSE');

      // Delete old items for this subject
      await queryRunner.manager.delete(RevenueItem, {
        schoolExpense: {
          id: schoolExpenseId,
        },
        subject: {
          id: body.subjectId,
        },
      });

      // Dòng có tiền từ đề xuất giữ nguyên id (cập nhật tại chỗ ở dưới).
      await queryRunner.manager.delete(SchoolExpenseItem, {
        schoolExpense: {
          id: schoolExpenseId,
        },
        subject: {
          id: body.subjectId,
        },
        ...(linkedSchool.size ? { id: Not(In([...linkedSchool.keys()])) } : {}),
      });

      if (!managementLocked) {
        // Dòng có tiền từ đề xuất giữ nguyên id (cập nhật tại chỗ ở dưới).
        await queryRunner.manager.delete(ManagementExpenseItem, {
          schoolExpense: {
            id: schoolExpenseId,
          },
          subject: {
            id: body.subjectId,
          },
          ...(linked.size ? { id: Not(In([...linked.keys()])) } : {}),
        });
      }

      const revenueItems = Array.isArray(body.revenueItems)
        ? body.revenueItems
        : [];
      const schoolExpenseItems = Array.isArray(body.schoolExpenseItems)
        ? body.schoolExpenseItems
        : [];
      const managementExpenseItems = managementLocked
        ? []
        : Array.isArray(body.managementExpenseItems)
          ? body.managementExpenseItems
          : [];

      const maxRows = Math.max(
        revenueItems.length,
        schoolExpenseItems.length,
        managementExpenseItems.length,
      );

      const sharedItems = Array.from(
        {
          length: maxRows,
        },
        (_, index) => ({
          ...(managementExpenseItems[index] || {}),
          ...(schoolExpenseItems[index] || {}),
          ...(revenueItems[index] || {}),
          rowIndex: index,
        }),
      );

      // Create revenue items
      for (const [index, item] of revenueItems.entries()) {
        const entity = queryRunner.manager.create(RevenueItem, {
          schoolExpense,
          subject,
          ...buildRevenueItemData(
            revenueLocked && lockedRevenueRows.has(index)
              ? { ...item, invoiceLocked: true }
              : item,
            index,
            sharedItems[index],
          ),
        });

        await queryRunner.manager.save(entity);
      }

      // Create school expense items
      const keptSchoolIds = new Set<number>();
      for (const [index, item] of schoolExpenseItems.entries()) {
        const built = buildSchoolExpenseItemData(item, index, sharedItems[index], {
          teacherSplit,
        });
        const linkedId = Number(item?.id);
        const linkedRow =
          linkedId && !keptSchoolIds.has(linkedId) ? linkedSchool.get(linkedId) : undefined;
        if (linkedRow) {
          // Ngày chi / Nguồn chi / Đã chi giữ số trên server, giữ id để giữ liên kết.
          keptSchoolIds.add(linkedId);
          await queryRunner.manager.update(
            SchoolExpenseItem,
            { id: linkedId },
            keepLinkedPaymentFields(built, linkedRow, built.schoolExpenseAmount),
          );
          continue;
        }
        const entity = queryRunner.manager.create(SchoolExpenseItem, {
          schoolExpense,
          subject,
          ...built,
        });

        await queryRunner.manager.save(entity);
      }

      // Create management expense items (+ Chi khác của từng dòng)
      const newManagementSnapshot: any[] = [];
      const keptLinkedIds = new Set<number>();
      for (const [index, item] of managementExpenseItems.entries()) {
        const shared = normalizeSharedFields(sharedItems[index], index);
        const rowIndex = shared.rowIndex;

        // otherCosts undefined → giữ dữ liệu cũ theo rowIndex; [] → xóa hết.
        const rawOtherCosts = Array.isArray(item?.otherCosts)
          ? item.otherCosts
          : oldOtherCostsByRow.get(rowIndex) ?? [];

        const { rows: otherCostRows, totalOtherCostAmount, totalOtherTaxAmount } =
          computeOtherCostRows(rawOtherCosts, shared);

        const built = buildManagementExpenseItemData(
          item,
          index,
          sharedItems[index],
          totalOtherCostAmount,
          totalOtherTaxAmount,
        );
        const linkedId = Number(item?.id);
        const linkedRow =
          linkedId && !keptLinkedIds.has(linkedId) ? linked.get(linkedId) : undefined;

        let savedItem: { id: number };
        if (linkedRow) {
          // Dòng có tiền từ đề xuất: cập nhật tại chỗ (giữ id để giữ liên kết),
          // Ngày chi / Nguồn chi / Đã chi giữ số trên server.
          keptLinkedIds.add(linkedId);
          await queryRunner.manager.update(
            ManagementExpenseItem,
            { id: linkedId },
            keepLinkedPaymentFields(built, linkedRow, built.totalOutside),
          );
          await queryRunner.manager.delete(ManagementExpenseOtherCost, {
            managementExpenseItemId: linkedId,
          });
          savedItem = { id: linkedId };
        } else {
          savedItem = await queryRunner.manager.save(
            queryRunner.manager.create(ManagementExpenseItem, {
              schoolExpense,
              subject,
              ...built,
            }),
          );
        }

        if (otherCostRows.length) {
          await queryRunner.manager.save(
            otherCostRows.map((oc) =>
              queryRunner.manager.create(ManagementExpenseOtherCost, {
                managementExpenseItemId: savedItem.id,
                policyOtherCostId: oc.policyOtherCostId,
                name: oc.name,
                unitPrice: oc.unitPrice,
                amount: oc.amount,
                tax: oc.tax,
                taxAmount: oc.taxAmount,
              }),
            ),
          );
        }

        newManagementSnapshot.push({
          ...(linkedRow ? keepLinkedPaymentFields(item, linkedRow, built.totalOutside) : item),
          rowIndex,
          otherCosts: otherCostRows,
        });
      }

      // Bảng đã khoá: chỉ ghi cột chi lên dòng cũ — không thêm / xoá dòng, phần
      // chính sách (đơn giá, thuế, Chi khác, Chi ngoài) giữ nguyên.
      if (managementPaymentOnly || managementDateSourceOnly) {
        newManagementSnapshot.push(
          ...(await updateRowsById(
            queryRunner.manager,
            ManagementExpenseItem,
            oldManagement,
            body.managementExpenseItems,
            (item, old) => {
              const linkedRow = linked.get(old.id);
              if (!managementPaymentOnly) {
                return linkedRow ? null : buildPaymentDateSourceData(item);
              }
              const totalOutside = Number(old.totalOutside ?? 0);
              const data = {
                ...buildManagementPaymentData(item, totalOutside),
                ...buildStandaloneContentData(
                  item,
                  old.rowIndex,
                  revenueItems.length,
                ),
              };
              return linkedRow
                ? keepLinkedPaymentFields(data, linkedRow, totalOutside)
                : data;
            },
          )),
        );
      }

      // Dòng thêm khi bảng đã khoá nằm sau dòng Doanh Thu cuối, nên giữ Nội dung
      // và số lượng riêng thay vì dùng chung với Doanh Thu.
      let nextRowIndex = Math.max(
        revenueItems.length,
        ...oldManagement.map((row) => Number(row.rowIndex) + 1),
      );
      for (const item of lockedManagementRows) {
        const data = buildLockedManagementRowData(item, nextRowIndex);
        nextRowIndex += 1;
        await queryRunner.manager.save(
          queryRunner.manager.create(ManagementExpenseItem, {
            schoolExpense,
            subject,
            ...data,
          }),
        );
        newManagementSnapshot.push(data);
      }

      // Bảng Giáo viên trường (kỳ từ 11/2026) lưu cùng transaction.
      const schoolTeacher = teacherSplit && sendsSchoolTeacher
        ? await this.replaceSchoolTeacherRows(
            queryRunner.manager,
            schoolExpenseId,
            body.subjectId,
            schoolExpense.school?.id,
            body.schoolTeacherItems,
            revenueItems,
          )
        : null;

      await queryRunner.manager.save(SchoolExpenseHistory, {
        schoolExpenseId,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'SAVE_ALL',
        entityType: 'school_expense',
        oldData: {
          revenueItems: oldRevenue,
          schoolExpenseItems: oldSchoolExpense,
          managementExpenseItems: oldManagement,
          ...(schoolTeacher ? { schoolTeacherItems: schoolTeacher.old } : {}),
        },
        newData: {
          subjectId: body.subjectId,
          revenueItems,
          schoolExpenseItems,
          // Kèm Chi khác đã tính (đơn giá + thành tiền) để suy ra lịch sử thay đổi.
          managementExpenseItems: newManagementSnapshot,
          ...(schoolTeacher
            ? {
                schoolTeacherItems: schoolTeacher.rows,
                schoolTeacherApprovalCleared: schoolTeacher.approvalCleared,
                schoolTeacherOtherSubjectsApprovalCleared:
                  schoolTeacher.otherSubjectsApprovalCleared,
              }
            : {}),
        },
      });

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }

    return await this.getItems(schoolExpenseId, body.subjectId);
  }

  /**
   * Bảng đã khoá: chính sách giữ nguyên nên tổng Chi ngoài tính từ dòng đã lưu, số
   * lượng theo dòng Doanh Thu cùng vị trí như FE. Dòng thêm mới không có Chi ngoài.
   */
  private lockedPaidTotals(
    oldManagement: ManagementExpenseItem[],
    body: any,
    addedRows: any[],
    linked: Map<number, LinkedManagementRow>,
  ) {
    const items: any[] = Array.isArray(body.managementExpenseItems)
      ? body.managementExpenseItems
      : [];
    const revenueItems: any[] = Array.isArray(body.revenueItems) ? body.revenueItems : [];
    const paidById = new Map(
      items.filter((item) => item?.id).map((item) => [Number(item.id), item.paidAmount]),
    );

    let oldPaid = 0;
    let newPaid = addedRows.reduce((sum, item) => sum + Number(item.paidAmount || 0), 0);
    let totalOutside = 0;
    for (const old of oldManagement) {
      const paid = Number(old.paidAmount ?? 0);
      oldPaid += paid;
      newPaid += linked.has(old.id) ? paid : Number(paidById.get(old.id) ?? paid);
      totalOutside += recomputeManagementOutside(old, revenueItems[old.rowIndex] ?? old);
    }

    return { oldPaid, newPaid, totalOutside };
  }

  /** Bảng chưa khoá hoặc kế toán trưởng: lưu lại toàn bộ dòng, tính theo số vừa gửi lên. */
  private submittedPaidTotals(
    oldManagement: ManagementExpenseItem[],
    body: any,
    oldOtherCostsByRow: Map<number, any[]>,
    linked: Map<number, LinkedManagementRow>,
  ) {
    const items: any[] = Array.isArray(body.managementExpenseItems)
      ? body.managementExpenseItems
      : [];
    const revenueItems: any[] = Array.isArray(body.revenueItems) ? body.revenueItems : [];
    const schoolItems: any[] = Array.isArray(body.schoolExpenseItems)
      ? body.schoolExpenseItems
      : [];

    let newPaid = 0;
    let totalOutside = 0;
    items.forEach((item, index) => {
      const sharedItem = {
        ...item,
        ...(schoolItems[index] || {}),
        ...(revenueItems[index] || {}),
        rowIndex: index,
      };
      const shared = normalizeSharedFields(sharedItem, index);
      const { totalOtherCostAmount, totalOtherTaxAmount } = computeOtherCostRows(
        Array.isArray(item?.otherCosts)
          ? item.otherCosts
          : oldOtherCostsByRow.get(shared.rowIndex) ?? [],
        shared,
      );
      const data = buildManagementExpenseItemData(
        item,
        index,
        sharedItem,
        totalOtherCostAmount,
        totalOtherTaxAmount,
      );
      const linkedRow = linked.get(Number(item?.id));
      newPaid += linkedRow ? linkedRow.paidAmount : data.paidAmount;
      totalOutside += data.totalOutside;
    });

    const oldPaid = oldManagement.reduce(
      (sum, row) => sum + Number(row.paidAmount ?? 0),
      0,
    );
    return { oldPaid, newPaid, totalOutside };
  }

  /**
   * Kỳ đã "Kết thúc": chỉ ghi Ngày chi + Nguồn chi lên các dòng Chi Trường /
   * Chi Ngoài đã có — doanh thu, đơn giá, Đã chi, Người chi... giữ nguyên.
   */
  private async saveFinalizedDateSource(
    schoolExpenseId: number,
    body: any,
    user: AuthUser | undefined,
    oldSchoolExpense: SchoolExpenseItem[],
    oldManagement: ManagementExpenseItem[],
    teacherSplit = false,
  ) {
    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.manager.query(
        `SELECT id FROM school_expenses WHERE id = $1 FOR UPDATE`,
        [schoolExpenseId],
      );
      const linked = await loadLinkedManagementRows(queryRunner.manager, {
        schoolExpenseId,
        subjectId: body.subjectId,
      });
      const linkedSchool = await loadLinkedManagementRows(
        queryRunner.manager,
        { schoolExpenseId, subjectId: body.subjectId },
        'SCHOOL_EXPENSE',
      );
      // Dòng có tiền từ đề xuất: Ngày chi / Nguồn chi khoá.
      const schoolExpenseItems = await updateRowsById(
        queryRunner.manager,
        SchoolExpenseItem,
        oldSchoolExpense,
        body.schoolExpenseItems,
        (item, old) => (linkedSchool.has(old.id) ? null : buildPaymentDateSourceData(item)),
      );
      // Dòng có tiền từ đề xuất: Ngày chi / Nguồn chi khoá.
      const managementExpenseItems = await updateRowsById(
        queryRunner.manager,
        ManagementExpenseItem,
        oldManagement,
        body.managementExpenseItems,
        (item, old) => (linked.has(old.id) ? null : buildPaymentDateSourceData(item)),
      );
      // Giáo viên trường: kỳ đã kết thúc chỉ còn Ngày chi + Nguồn chi.
      const oldSchoolTeacher = teacherSplit
        ? await queryRunner.manager.find(SchoolTeacherExpenseItem, {
            where: { schoolExpenseId, subjectId: body.subjectId },
          })
        : [];
      const linkedTeacher = teacherSplit
        ? await loadLinkedTeacherRows(queryRunner.manager, {
            schoolExpenseId,
            subjectId: body.subjectId,
          })
        : new Map();
      const schoolTeacherItems = teacherSplit
        ? await updateRowsById(
            queryRunner.manager,
            SchoolTeacherExpenseItem,
            oldSchoolTeacher,
            body.schoolTeacherItems,
            (item, old) => {
              // Dòng do đề xuất chi trả: Ngày chi / Nguồn chi là của đề xuất.
              if (linkedTeacher.has(old.id)) return null;
              const { expenseDate, cashAccount } = buildSchoolTeacherPaymentData(item);
              return { expenseDate, cashAccount };
            },
          )
        : null;

      await queryRunner.manager.save(SchoolExpenseHistory, {
        schoolExpenseId,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'SAVE_ALL',
        entityType: 'school_expense',
        oldData: {
          schoolExpenseItems: oldSchoolExpense,
          managementExpenseItems: oldManagement,
          ...(schoolTeacherItems ? { schoolTeacherItems: oldSchoolTeacher } : {}),
        },
        newData: {
          subjectId: body.subjectId,
          schoolExpenseItems,
          managementExpenseItems,
          ...(schoolTeacherItems ? { schoolTeacherItems } : {}),
        },
      });

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Bảng Giáo viên trường của một môn: xoá rồi ghi lại (dòng không có liên kết
   * nào cần giữ theo id). Dòng đi kèm Doanh Thu (vị trí < số dòng Doanh Thu)
   * lấy số lượng của Doanh Thu; dòng thêm riêng trống thì bỏ. Thuế TNCN tính lại
   * cho cả bảng thu chi (giáo viên dạy nhiều môn cộng chung ngưỡng 5 triệu).
   * Môn nào đổi số tiền (kể cả do thuế đổi theo) thì bỏ dấu "Duyệt lương".
   */
  private async replaceSchoolTeacherRows(
    manager: EntityManager,
    schoolExpenseId: number,
    subjectId: number,
    schoolId: number | undefined,
    items: any[],
    revenueItems: any[],
  ) {
    const repo = manager.getRepository(SchoolTeacherExpenseItem);
    const sheetBefore = await repo.find({
      where: { schoolExpenseId },
      order: { rowIndex: 'ASC', id: 'ASC' },
    });
    const old = sheetBefore.filter((row) => row.subjectId === subjectId);
    // Dòng do đề xuất chi trả: giữ id (liên kết), Ngày chi / Nguồn chi giữ số
    // của đề xuất, không xoá được.
    const linked = await loadLinkedTeacherRows(manager, { schoolExpenseId, subjectId });
    assertLinkedRowsKept(linked, items, 'SCHOOL_TEACHER');

    const revenueCount = revenueItems.length;
    const rows: (ReturnType<typeof buildSchoolTeacherItemData> & { sourceId: number })[] = [];
    let nextStandalone = revenueCount;
    items.forEach((item, index) => {
      const standalone = index >= revenueCount;
      const row = buildSchoolTeacherItemData(
        item,
        standalone ? nextStandalone : index,
        standalone ? item : { ...revenueItems[index], rowIndex: index },
        standalone,
      );
      if (
        standalone &&
        !row.content &&
        !row.schoolTeacherId &&
        !(row.amount > 0) &&
        !row.expenseDate &&
        !row.cashAccount &&
        !row.note
      ) {
        return;
      }
      if (standalone) nextStandalone += 1;
      rows.push({ ...row, sourceId: Number(item?.id) || 0 });
    });

    // Giáo viên phải thuộc danh sách giáo viên của chính trường này.
    const teacherIds = [
      ...new Set(rows.map((row) => row.schoolTeacherId).filter((id): id is number => !!id)),
    ];
    if (teacherIds.length) {
      const found = await manager.getRepository(SchoolTeacher).find({
        where: { id: In(teacherIds), ...(schoolId ? { schoolId } : {}) },
      });
      if (found.length !== teacherIds.length) {
        throw new BadRequestException('Giáo viên đã chọn không thuộc danh sách giáo viên của trường');
      }
    }

    const kept = new Set<number>();
    const inserts: ReturnType<typeof buildSchoolTeacherItemData>[] = [];
    const updates: { id: number; data: ReturnType<typeof buildSchoolTeacherItemData> }[] = [];
    for (const { sourceId, ...row } of rows) {
      const linkedRow = sourceId && !kept.has(sourceId) ? linked.get(sourceId) : undefined;
      if (linkedRow) {
        kept.add(sourceId);
        updates.push({
          id: sourceId,
          data: { ...row, expenseDate: linkedRow.expenseDate, cashAccount: linkedRow.cashAccount },
        });
      } else {
        inserts.push(row);
      }
    }
    // Dòng trống bị bỏ qua cũng là bị xoá.
    for (const [id, row] of linked) {
      if (!kept.has(id)) throw linkedRowDeleteError(row.payments, 'SCHOOL_TEACHER');
    }
    await repo.delete({
      schoolExpenseId,
      subjectId,
      ...(kept.size ? { id: Not(In([...kept])) } : {}),
    });
    for (const update of updates) {
      await repo.update({ id: update.id }, update.data);
    }
    if (inserts.length) {
      await repo.insert(inserts.map((row) => ({ ...row, schoolExpenseId, subjectId })));
    }

    // Thuế TNCN theo giáo viên trên cả bảng thu chi.
    const sheetAfter = await repo.find({
      where: { schoolExpenseId },
      order: { rowIndex: 'ASC', id: 'ASC' },
    });
    const tax = allocateSchoolTeacherTax(
      sheetAfter.map((row) => ({
        key: row.id,
        schoolTeacherId: row.schoolTeacherId,
        amount: Number(row.amount || 0),
      })),
    );
    for (const row of sheetAfter) {
      const next = tax.get(row.id)!;
      if (
        Number(row.pitRate) !== next.pitRate ||
        Number(row.pitAmount) !== next.pitAmount ||
        Number(row.netAmount) !== next.netAmount
      ) {
        await repo.update({ id: row.id }, next);
        Object.assign(row, next);
      }
    }

    // Bỏ dấu duyệt của mọi môn có số tiền đổi (môn đang lưu + môn đổi thuế theo).
    const subjectIds = [...new Set([...sheetBefore, ...sheetAfter].map((row) => row.subjectId))];
    const clearedSubjects: number[] = [];
    for (const id of subjectIds) {
      const before = sheetBefore.filter((row) => row.subjectId === id);
      const after = sheetAfter.filter((row) => row.subjectId === id);
      if (schoolTeacherMoneySignature(before) !== schoolTeacherMoneySignature(after)) {
        clearedSubjects.push(id);
        await manager.delete(SchoolTeacherPayrollApproval, { schoolExpenseId, subjectId: id });
      }
    }
    return {
      old,
      rows: sheetAfter.filter((row) => row.subjectId === subjectId),
      approvalCleared: clearedSubjects.includes(subjectId),
      otherSubjectsApprovalCleared: clearedSubjects.filter((id) => id !== subjectId),
    };
  }

  /** Bảng Giáo viên trường + dấu "Duyệt lương" của một môn. */
  async getSchoolTeacherItems(schoolExpenseId: number, subjectId: number) {
    if (!subjectId) throw new BadRequestException('subjectId is required');
    const schoolExpense = await this.schoolExpenseRepository.findOne({
      where: { id: schoolExpenseId },
      relations: { period: true, school: true },
    });
    if (!schoolExpense) throw new NotFoundException('SchoolExpense not found');

    const [sheetRows, approval] = await Promise.all([
      this.dataSource.getRepository(SchoolTeacherExpenseItem).find({
        where: { schoolExpenseId },
        order: { rowIndex: 'ASC', id: 'ASC' },
      }),
      this.dataSource
        .getRepository(SchoolTeacherPayrollApproval)
        .findOne({ where: { schoolExpenseId, subjectId } }),
    ]);
    const items = sheetRows.filter((row) => row.subjectId === subjectId);
    const teacherPayments = await loadSuggestPayments(
      this.dataSource.manager,
      items.map((row) => row.id),
      'SCHOOL_TEACHER',
    );
    // Thù lao của từng giáo viên ở các môn khác cùng bảng thu chi — để màn hình
    // tính đúng ngưỡng thuế 5 triệu khi đang sửa một môn.
    const otherSubjectGross: Record<number, number> = {};
    for (const row of sheetRows) {
      if (row.subjectId === subjectId || !row.schoolTeacherId) continue;
      otherSubjectGross[row.schoolTeacherId] =
        (otherSubjectGross[row.schoolTeacherId] ?? 0) + Number(row.amount || 0);
    }
    const usedTeacherIds = items
      .map((row) => row.schoolTeacherId)
      .filter((id): id is number => !!id);
    const teachers = schoolExpense.school?.id
      ? await this.dataSource.getRepository(SchoolTeacher).find({
          where: [
            { schoolId: schoolExpense.school.id, isActive: true },
            ...(usedTeacherIds.length
              ? [{ schoolId: schoolExpense.school.id, id: In(usedTeacherIds) }]
              : []),
          ],
          order: { name: 'ASC', id: 'ASC' },
        })
      : [];
    return {
      applies: schoolTeacherSplitApplies(schoolExpense.period),
      splitFrom: SCHOOL_TEACHER_SPLIT_FROM,
      schoolId: schoolExpense.school?.id ?? null,
      teachers,
      otherSubjectGross,
      items: items.map((item) => {
        const found = teacherPayments.get(item.id);
        return {
          ...item,
          paid: schoolTeacherPaid(item) || !!found,
          // Trả theo đề xuất chi: màn hình khoá Ngày chi / Nguồn chi, hiện mã.
          ...(found ? { suggestCodes: suggestCodesLabel(found) } : {}),
        };
      }),
      approval: approval
        ? {
            approvedBy: approval.approvedBy,
            approvedByName: approval.approvedByName,
            approvedAt: approval.approvedAt,
          }
        : null,
    };
  }

  /** "Duyệt lương" bảng Giáo viên trường của một môn: chỉ ghi người + thời điểm. */
  async approveSchoolTeacher(
    schoolExpenseId: number,
    subjectId: number,
    user: AuthUser,
  ) {
    if (!subjectId) throw new BadRequestException('subjectId is required');
    await this.dataSource.transaction(async (manager) => {
      const [sheet] = await manager.query<{ month: number; year: number }[]>(
        `SELECT ep.month, ep.year FROM school_expenses se
         JOIN expense_periods ep ON ep.id = se.period_id
         WHERE se.id = $1 FOR UPDATE OF se`,
        [schoolExpenseId],
      );
      if (!sheet) throw new NotFoundException('SchoolExpense not found');
      if (!schoolTeacherSplitApplies(sheet)) {
        throw new BadRequestException(
          'Kỳ này chưa có bảng Giáo viên trường (áp dụng từ kỳ tháng 11/2026)',
        );
      }
      const rows = await manager.find(SchoolTeacherExpenseItem, {
        where: { schoolExpenseId, subjectId },
      });
      if (!rows.some((row) => Number(row.amount) > 0)) {
        throw new BadRequestException(
          'Bảng Giáo viên trường chưa có lương để duyệt — nhập và lưu trước',
        );
      }
      const approvedByName = user?.name ?? null;
      await manager.upsert(
        SchoolTeacherPayrollApproval,
        {
          schoolExpenseId,
          subjectId,
          approvedBy: user?.id ?? null,
          approvedByName,
          approvedAt: new Date(),
        },
        ['schoolExpenseId', 'subjectId'],
      );
      await manager.save(SchoolExpenseHistory, {
        schoolExpenseId,
        updatedById: user?.id,
        updatedByName: approvedByName ?? undefined,
        action: 'APPROVE_SCHOOL_TEACHER_PAYROLL',
        entityType: 'school_expense',
        oldData: null,
        newData: {
          subjectId,
          total: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
          netTotal: rows.reduce((sum, row) => sum + Number(row.netAmount || 0), 0),
        },
      });
    });
    return this.getSchoolTeacherItems(schoolExpenseId, subjectId);
  }

  async getItems(schoolExpenseId: number, subjectId: number) {
    if (!subjectId) {
      throw new BadRequestException('subjectId is required');
    }

    const schoolExpense = await this.schoolExpenseRepository.findOne({
      where: {
        id: schoolExpenseId,
      },
    });

    if (!schoolExpense) {
      throw new NotFoundException('SchoolExpense not found');
    }

    const subject = await this.subjectRepository.findOne({
      where: {
        id: subjectId,
      },
    });

    if (!subject) {
      throw new NotFoundException('Subject not found');
    }

    const where = {
      schoolExpense: {
        id: schoolExpenseId,
      },
      subject: {
        id: subjectId,
      },
    };

    const [revenueItems, schoolExpenseItems, managementExpenseItems] =
      await Promise.all([
        this.revenueItemRepository.find({
          where,
          relations: {
            subject: true,
            schoolExpense: true,
          },
          order: {
            rowIndex: 'ASC',
            id: 'ASC',
          },
        }),
        this.schoolExpenseItemRepository.find({
          where,
          relations: {
            subject: true,
            schoolExpense: true,
          },
          order: {
            rowIndex: 'ASC',
            id: 'ASC',
          },
        }),
        this.managementExpenseItemRepository.find({
          where,
          relations: {
            subject: true,
            schoolExpense: true,
            otherCosts: true,
          },
          order: {
            rowIndex: 'ASC',
            id: 'ASC',
          },
        }),
      ]);

    const suggestPayments = await loadSuggestPayments(
      this.dataSource.manager,
      managementExpenseItems.map((item) => item.id),
    );
    const schoolSuggestPayments = await loadSuggestPayments(
      this.dataSource.manager,
      schoolExpenseItems.map((item) => item.id),
      'SCHOOL_EXPENSE',
    );

    return {
      revenueItems,
      schoolExpenseItems: schoolExpenseItems.map((item) =>
        withSuggestPayments(item, schoolSuggestPayments),
      ),
      managementExpenseItems: managementExpenseItems.map((item) =>
        withSuggestPayments(this.withOtherCosts(item), suggestPayments),
      ),
    };
  }

  /** Map 1 khoản "Chi khác" ra response (decimal → number, nhất quán mọi endpoint). */
  private mapOtherCost(oc: ManagementExpenseOtherCost) {
    return {
      id: oc.id,
      policyOtherCostId: oc.policyOtherCostId ?? null,
      name: oc.name ?? null,
      unitPrice: Number(oc.unitPrice ?? 0),
      amount: Number(oc.amount ?? 0),
      tax: Number(oc.tax ?? 0),
      taxAmount: Number(oc.taxAmount ?? 0),
    };
  }

  /** Gắn `otherCosts` (đã map) + tổng chi phí/thuế (+ subjectId) vào 1 management item. */
  private withOtherCosts(item: ManagementExpenseItem) {
    const otherCosts = (item.otherCosts ?? []).map((oc) =>
      this.mapOtherCost(oc),
    );
    const totalOtherCostAmount = otherCosts.reduce(
      (sum, oc) => sum + oc.amount,
      0,
    );
    // Các field thuế trả về dạng number, nhất quán mọi endpoint.
    const ql1TaxAmount = Number(item.ql1TaxAmount ?? 0);
    const ql2TaxAmount = Number(item.ql2TaxAmount ?? 0);
    const totalTaxAmount =
      ql1TaxAmount +
      ql2TaxAmount +
      otherCosts.reduce((sum, oc) => sum + oc.taxAmount, 0);
    return {
      ...item,
      subjectId: item.subject?.id ?? null,
      otherCosts,
      totalOtherCostAmount,
      ql1TaxAmount,
      ql2TaxAmount,
      totalTaxAmount,
    };
  }

  // SUMMARY
  async getSummary(schoolExpenseId: number, subjectId?: number) {
    const schoolExpense = await this.schoolExpenseRepository.findOne({
      where: {
        id: schoolExpenseId,
      },
    });

    if (!schoolExpense) {
      throw new NotFoundException('SchoolExpense not found');
    }

    const revenueWhere: any = {
      schoolExpense: {
        id: schoolExpenseId,
      },
    };

    const expenseWhere: any = {
      schoolExpense: {
        id: schoolExpenseId,
      },
    };

    const managementWhere: any = {
      schoolExpense: {
        id: schoolExpenseId,
      },
    };

    if (subjectId) {
      revenueWhere.subject = {
        id: subjectId,
      };
      expenseWhere.subject = {
        id: subjectId,
      };
      managementWhere.subject = {
        id: subjectId,
      };
    }

    const [revenueItems, schoolExpenseItems, managementExpenseItems] =
      await Promise.all([
        this.revenueItemRepository.find({
          where: revenueWhere,
          relations: { subject: true },
          order: { rowIndex: 'ASC', id: 'ASC' },
        }),
        this.schoolExpenseItemRepository.find({
          where: expenseWhere,
          relations: { subject: true },
          order: { rowIndex: 'ASC', id: 'ASC' },
        }),
        this.managementExpenseItemRepository.find({
          where: managementWhere,
          relations: { subject: true, otherCosts: true },
          order: { rowIndex: 'ASC', id: 'ASC' },
        }),
      ]);

    const totalRevenue = revenueItems.reduce(
      (sum, item) => sum + Number(item.invoiceAmount || 0),
      0,
    );

    const totalRevenuePaid = revenueItems.reduce(
      (sum, item) => sum + Number(item.paidAmount || 0),
      0,
    );

    const totalRevenueRemaining = revenueItems.reduce(
      (sum, item) => sum + Number(item.remainingAmount || 0),
      0,
    );

    // Giáo viên trường (kỳ từ 11/2026) tách khỏi Chi Trường nhưng vẫn là chi của
    // trường: cộng vào các tổng Chi Trường để tổng chi / lợi nhuận không đổi.
    // Đã trả (đủ Ngày chi + Nguồn chi) tính cả Thành tiền — thuế TNCN đã khấu trừ.
    const schoolTeacherTotals = await this.schoolTeacherTotals(
      schoolExpenseId,
      subjectId,
    );

    const totalSchoolExpense = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.schoolExpenseAmount || 0),
      schoolTeacherTotals.totals.amount,
    );

    const totalSchoolExpensePaid = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.paidAmount || 0),
      schoolTeacherTotals.totals.paid,
    );

    const totalSchoolExpenseRemaining = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.remaining || 0),
      schoolTeacherTotals.totals.remaining,
    );

    const totalManagementExpense = managementExpenseItems.reduce(
      (sum, item) => sum + Number(item.totalOutside || 0),
      0,
    );

    const totalManagementExpensePaid = managementExpenseItems.reduce(
      (sum, item) => sum + Number(item.paidAmount || 0),
      0,
    );

    const totalManagementExpenseRemaining = managementExpenseItems.reduce(
      (sum, item) => sum + Number(item.remaining || 0),
      0,
    );

    const totalPaid =
      totalRevenuePaid + totalSchoolExpensePaid + totalManagementExpensePaid;
    const totalRemaining =
      totalRevenueRemaining +
      totalSchoolExpenseRemaining +
      totalManagementExpenseRemaining;

    const totalExpense = totalSchoolExpense + totalManagementExpense;
    const totalExpensePaid = totalSchoolExpensePaid + totalManagementExpensePaid;

    // decimal (pg trả string) → number cho bảng Tổng hợp
    const num = (v: any) => (v === null || v === undefined ? 0 : Number(v));

    const mapRevenue = (i: RevenueItem) => ({
      id: i.id,
      subjectId: i.subject?.id ?? null,
      rowIndex: i.rowIndex,
      content: i.content,
      totalPeriods: num(i.totalPeriods),
      studentCount: num(i.studentCount),
      monthsCount: num(i.monthsCount),
      unitPrice: num(i.unitPrice),
      invoiceAmount: num(i.invoiceAmount),
      invoiced: i.invoiced,
      invoiceType: i.invoiceType,
      invoiceOther: i.invoiceOther,
      invoiceNumber: i.invoiceNumber,
      invoiceDate: i.invoiceDate,
      invoiceLocked: i.invoiceLocked,
      paidAmount: num(i.paidAmount),
      paymentMethod: i.paymentMethod,
      paymentDate: i.paymentDate,
      remainingAmount: num(i.remainingAmount),
    });

    const mapSchoolExpense = (i: SchoolExpenseItem) => ({
      id: i.id,
      subjectId: i.subject?.id ?? null,
      rowIndex: i.rowIndex,
      totalPeriods: num(i.totalPeriods),
      studentCount: num(i.studentCount),
      monthsCount: num(i.monthsCount),
      teacherUnitPrice: num(i.giaovien),
      taxUnitPrice: num(i.thue),
      csvcUnitPrice: num(i.csvc),
      teacherAmount: num(i.teacherAmount),
      taxAmount: num(i.taxAmount),
      csvcAmount: num(i.csvcAmount),
      schoolExpenseAmount: num(i.schoolExpenseAmount),
      paidAmount: num(i.paidAmount),
      remaining: num(i.remaining),
      paymentType: i.paymentType,
      expenseDate: i.expenseDate,
      payer: i.payer,
      note: i.note,
    });

    const mapManagementExpense = (i: ManagementExpenseItem) => {
      const otherCosts = (i.otherCosts ?? []).map((oc) => this.mapOtherCost(oc));
      const totalOtherCostAmount = otherCosts.reduce(
        (sum, oc) => sum + oc.amount,
        0,
      );
      return {
        id: i.id,
        subjectId: i.subject?.id ?? null,
        rowIndex: i.rowIndex,
        totalPeriods: num(i.totalPeriods),
        studentCount: num(i.studentCount),
        monthsCount: num(i.monthsCount),
        ql1UnitPrice: num(i.ql1UnitPrice),
        ql2UnitPrice: num(i.ql2UnitPrice),
        ql1Amount: num(i.ql1Amount),
        ql2Amount: num(i.ql2Amount),
        ql1Tax: num(i.ql1Tax),
        ql2Tax: num(i.ql2Tax),
        ql1TaxAmount: num(i.ql1TaxAmount),
        ql2TaxAmount: num(i.ql2TaxAmount),
        totalTaxAmount: num(i.totalTaxAmount),
        otherCosts,
        totalOtherCostAmount,
        totalOutside: num(i.totalOutside),
        contractAmount: num(i.contractAmount),
        invoiceAmount: num(i.invoiceAmount),
        paidAmount: num(i.paidAmount),
        remaining: num(i.remaining),
        collectedDate: i.collectedDate,
        expenseDate: i.expenseDate,
        payer: i.payer,
        note: i.note,
      };
    };

    return {
      // Giữ nguyên các field tổng ở top-level (KPI cũ vẫn đọc được).
      totalRevenue,
      totalSchoolExpense,
      totalManagementExpense,
      totalPaid,
      totalRemaining,

      // Shape mới cho bảng "Tổng hợp": tổng đầy đủ + chi tiết từng dòng.
      summary: {
        totalRevenue,
        totalRevenuePaid,
        totalRevenueRemaining,
        totalSchoolExpense,
        totalSchoolExpensePaid,
        totalManagementExpense,
        totalManagementExpensePaid,
        totalExpense,
        totalExpensePaid,
        totalPaid,
        totalRemaining,
        revenueItems: revenueItems.map(mapRevenue),
        schoolExpenseItems: schoolExpenseItems.map(mapSchoolExpense),
        managementExpenseItems: managementExpenseItems.map(mapManagementExpense),
        // Tổng bảng Giáo viên trường (đã cộng vào các tổng Chi Trường ở trên).
        schoolTeacherTotals: schoolTeacherTotals.totals,
        // Số tiền theo từng dòng (không có chi tiết lương) để bảng Tổng hợp cộng
        // vào Chi Trường cùng dòng.
        schoolTeacherItems: schoolTeacherTotals.items,
      },
    };
  }

  /** Môn phải thuộc trường của bảng thu chi. */
  private async assertSubjectOfSheet(schoolExpense: SchoolExpense, subjectId: number) {
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      throw new BadRequestException('Chọn môn cần xác nhận BBCS');
    }
    const subject = await this.subjectRepository.findOne({ where: { id: subjectId } });
    if (!subject || subject.schoolId !== schoolExpense.school?.id) {
      throw new BadRequestException('Môn không thuộc trường của bảng thu chi');
    }
  }

  /** Tổng bảng Giáo viên trường của một bảng thu chi (một môn hoặc mọi môn). */
  private async schoolTeacherTotals(schoolExpenseId: number, subjectId?: number) {
    const rows = await this.dataSource
      .getRepository(SchoolTeacherExpenseItem)
      .find({
        where: subjectId ? { schoolExpenseId, subjectId } : { schoolExpenseId },
      });
    const sum = (pick: (row: SchoolTeacherExpenseItem) => number) =>
      rows.reduce((total, row) => total + pick(row), 0);
    const paidOf = (row: SchoolTeacherExpenseItem) =>
      schoolTeacherPaid(row) ? Number(row.amount || 0) : 0;
    const amount = sum((row) => Number(row.amount || 0));
    const paid = sum(paidOf);
    return {
      totals: {
        amount,
        pitAmount: sum((row) => Number(row.pitAmount || 0)),
        netAmount: sum((row) => Number(row.netAmount || 0)),
        paid,
        remaining: amount - paid,
      },
      items: rows.map((row) => ({
        subjectId: row.subjectId,
        rowIndex: row.rowIndex,
        amount: Number(row.amount || 0),
        paidAmount: paidOf(row),
        remaining: Number(row.amount || 0) - paidOf(row),
      })),
    };
  }

  /**
   * Cờ cũ ở cấp bảng thu chi giữ đồng bộ (= còn môn nào đã xác nhận) để bản
   * trước 12/11/2026 vẫn chạy được nếu phải quay lại.
   */
  private async syncLegacyConfirmation(manager: EntityManager, data: SchoolExpense) {
    const first = await manager
      .getRepository(SchoolExpenseManagementConfirmation)
      .findOne({ where: { schoolExpenseId: data.id }, order: { confirmedAt: 'ASC' } });
    data.managementExpenseConfirmed = !!first;
    data.managementExpenseConfirmedBy = first?.confirmedBy ?? null;
    data.managementExpenseConfirmedByName = first?.confirmedByName ?? null;
    data.managementExpenseConfirmedAt = first?.confirmedAt ?? null;
    await manager.save(SchoolExpense, data);
  }

  /**
   * Sales admin xác nhận bảng "Chi Ngoài" của MỘT MÔN → khoá chỉnh sửa môn đó
   * (chỉ kế toán trưởng còn sửa được). Idempotent: gọi lại khi đã khoá vẫn trả
   * về trạng thái hiện tại, không lỗi.
   */
  async confirmManagementExpense(id: number, subjectId: number, user?: AuthUser) {
    const data = await this.schoolExpenseRepository.findOne({
      where: { id },
      relations: { school: true },
    });
    if (!data) {
      throw new NotFoundException('SchoolExpense not found');
    }
    assertNotFinalized(data);
    await this.assertSubjectOfSheet(data, subjectId);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SchoolExpenseManagementConfirmation);
      if (await repo.exists({ where: { schoolExpenseId: id, subjectId } })) return;
      const confirmedAt = new Date();
      await repo.insert({
        schoolExpenseId: id,
        subjectId,
        confirmedBy: user?.id ?? null,
        confirmedByName: user?.name ?? null,
        confirmedAt,
      });
      await this.syncLegacyConfirmation(manager, data);
      await manager.save(SchoolExpenseHistory, {
        schoolExpenseId: id,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'CONFIRM_MANAGEMENT_EXPENSE',
        entityType: 'management_expense',
        oldData: { subjectId, managementExpenseConfirmed: false },
        newData: { subjectId, managementExpenseConfirmed: true, managementExpenseConfirmedAt: confirmedAt },
      });
    });

    return this.lockState(data);
  }

  /** Kế toán trưởng mở khoá "Xác nhận đúng BBCS" của bảng Chi Ngoài MỘT MÔN. */
  async unconfirmManagementExpense(id: number, subjectId: number, user?: AuthUser) {
    const data = await this.schoolExpenseRepository.findOne({
      where: { id },
      relations: { school: true },
    });
    if (!data) {
      throw new NotFoundException('SchoolExpense not found');
    }
    assertNotFinalized(data);
    await this.assertSubjectOfSheet(data, subjectId);

    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SchoolExpenseManagementConfirmation);
      const existing = await repo.findOne({ where: { schoolExpenseId: id, subjectId } });
      if (!existing) return;
      await repo.delete({ schoolExpenseId: id, subjectId });
      await this.syncLegacyConfirmation(manager, data);
      await manager.save(SchoolExpenseHistory, {
        schoolExpenseId: id,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'UNCONFIRM_MANAGEMENT_EXPENSE',
        entityType: 'management_expense',
        oldData: {
          subjectId,
          managementExpenseConfirmed: true,
          managementExpenseConfirmedByName: existing.confirmedByName,
          managementExpenseConfirmedAt: existing.confirmedAt,
        },
        newData: { subjectId, managementExpenseConfirmed: false },
      });
    });

    return this.lockState(data);
  }

  /** Kế toán trưởng "Kết thúc" kỳ thu chi → khoá toàn bộ, kể cả kế toán trưởng. */
  async finalize(id: number, user?: AuthUser) {
    const data = await this.schoolExpenseRepository.findOne({ where: { id } });
    if (!data) {
      throw new NotFoundException('SchoolExpense not found');
    }

    if (!data.finalized) {
      data.finalized = true;
      data.finalizedBy = user?.id ?? null;
      data.finalizedByName = user?.name ?? null;
      data.finalizedAt = new Date();
      await this.schoolExpenseRepository.save(data);

      await this.historyRepository.save({
        schoolExpenseId: id,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'FINALIZE',
        entityType: 'school_expense',
        oldData: { finalized: false },
        newData: { finalized: true, finalizedAt: data.finalizedAt },
      });
    }

    return this.lockState(data);
  }

  /** Kế toán trưởng mở lại kỳ thu chi đã "Kết thúc". */
  async reopen(id: number, user?: AuthUser) {
    const data = await this.schoolExpenseRepository.findOne({ where: { id } });
    if (!data) {
      throw new NotFoundException('SchoolExpense not found');
    }

    if (data.finalized) {
      const oldData = {
        finalized: true,
        finalizedByName: data.finalizedByName,
        finalizedAt: data.finalizedAt,
      };
      data.finalized = false;
      data.finalizedBy = null;
      data.finalizedByName = null;
      data.finalizedAt = null;
      await this.schoolExpenseRepository.save(data);

      await this.historyRepository.save({
        schoolExpenseId: id,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'REOPEN',
        entityType: 'school_expense',
        oldData,
        newData: { finalized: false },
      });
    }

    return this.lockState(data);
  }

  private async lockState(data: SchoolExpense) {
    return {
      id: data.id,
      // Xác nhận đúng BBCS theo từng môn; các cờ managementExpense* bên dưới là
      // dạng cũ (= còn môn nào đã xác nhận), giữ cho màn hình bản cũ.
      managementConfirmations: (
        await loadManagementConfirmations(this.dataSource.manager, [data.id])
      ).map(confirmationView),
      managementExpenseConfirmed: data.managementExpenseConfirmed,
      managementExpenseConfirmedBy: data.managementExpenseConfirmedBy,
      managementExpenseConfirmedByName: data.managementExpenseConfirmedByName,
      managementExpenseConfirmedAt: data.managementExpenseConfirmedAt,
      finalized: data.finalized,
      finalizedBy: data.finalizedBy,
      finalizedByName: data.finalizedByName,
      finalizedAt: data.finalizedAt,
    };
  }
}
