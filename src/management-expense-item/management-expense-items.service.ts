import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { ManagementExpenseItem } from './management-expense-item.entity';
import { ManagementExpenseOtherCost } from './management-expense-other-cost.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';
import {
  assertManagementPaidWithinOutside,
  assertNotFinalized,
  buildManagementExpenseItemData,
  computeOtherCostRows,
  normalizeSharedFields,
  recomputeManagementOutside,
} from '../school-expenses/expense-calculations';
import { AuthUser } from '../type/auth-user.type';
import {
  keepLinkedPaymentFields,
  linkedRowDeleteError,
  loadLinkedManagementRows,
  loadSuggestPayments,
  withSuggestPayments,
} from './suggest-payments';

@Injectable()
export class ManagementExpenseItemsService {
  constructor(
    @InjectRepository(ManagementExpenseItem)
    private readonly managementExpenseItemRepository: Repository<ManagementExpenseItem>,

    @InjectRepository(SchoolExpense)
    private readonly schoolExpenseRepository: Repository<SchoolExpense>,

    @InjectRepository(Subject)
    private readonly subjectRepository: Repository<Subject>,

    @InjectRepository(SchoolExpenseHistory)
    private readonly historyRepository: Repository<SchoolExpenseHistory>,

    private readonly dataSource: DataSource,
  ) {}

  /** Cùng quy tắc với lưu toàn bộ: tổng Đã chi của môn không vượt tổng Chi ngoài. */
  private async assertPaidWithinOutside(
    schoolExpenseId: number,
    subjectId: number,
    next: { paidAmount: number; totalOutside: number },
    excludeId?: number,
  ) {
    const rows = await this.managementExpenseItemRepository.find({
      where: {
        schoolExpense: { id: schoolExpenseId },
        subject: { id: subjectId },
      },
      relations: { otherCosts: true },
    });

    let oldPaid = 0;
    let newPaid = next.paidAmount;
    let totalOutside = next.totalOutside;
    for (const row of rows) {
      const paid = Number(row.paidAmount ?? 0);
      oldPaid += paid;
      if (row.id === excludeId) continue;
      newPaid += paid;
      totalOutside += recomputeManagementOutside(row);
    }

    assertManagementPaidWithinOutside({ oldPaid, newPaid, totalOutside });
  }

  /**
   * Bảng "Chi Ngoài" bị khoá sau khi sales admin xác nhận
   * (`SchoolExpense.managementExpenseConfirmed`) — chỉ kế toán trưởng còn sửa
   * được sau khi khoá.
   */
  private assertNotLocked(schoolExpense: SchoolExpense, user?: AuthUser) {
    assertNotFinalized(schoolExpense);
    if (!schoolExpense.managementExpenseConfirmed) return;
    const isChiefAccountant = (user?.roles ?? []).includes('ketoan_truong');
    if (!isChiefAccountant) {
      throw new ForbiddenException(
        'Bảng "Chi Ngoài" đã được xác nhận và khoá — chỉ kế toán trưởng được sửa',
      );
    }
  }

  /** Map "Chi khác" → response (decimal → number). */
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

  private withOtherCosts(item: ManagementExpenseItem) {
    const otherCosts = (item.otherCosts ?? []).map((oc) =>
      this.mapOtherCost(oc),
    );
    const totalOtherCostAmount = otherCosts.reduce(
      (sum, oc) => sum + oc.amount,
      0,
    );
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

  private findOneWithOtherCosts(id: number) {
    return this.managementExpenseItemRepository.findOne({
      where: { id },
      relations: { subject: true, schoolExpense: true, otherCosts: true },
    });
  }

  // CREATE
  async create(body: any, user?: AuthUser) {
    const [schoolExpense, subject] = await Promise.all([
      this.schoolExpenseRepository.findOne({
        where: {
          id: body.schoolExpenseId,
        },
        relations: {
          school: true,
        },
      }),

      this.subjectRepository.findOne({
        where: {
          id: body.subjectId,
        },
      }),
    ]);

    if (!schoolExpense) {
      throw new NotFoundException('SchoolExpense not found');
    }

    if (!subject) {
      throw new NotFoundException('Subject not found');
    }

    if (subject.schoolId !== schoolExpense.school?.id) {
      throw new BadRequestException('Subject does not belong to school');
    }

    this.assertNotLocked(schoolExpense, user);

    const shared = normalizeSharedFields(body);
    const { rows: otherCostRows, totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows(
        Array.isArray(body.otherCosts) ? body.otherCosts : [],
        shared,
      );

    const data = buildManagementExpenseItemData(
      body,
      0,
      body,
      totalOtherCostAmount,
      totalOtherTaxAmount,
    );

    await this.assertPaidWithinOutside(body.schoolExpenseId, body.subjectId, data);

    const savedId = await this.dataSource.transaction(async (manager) => {
      const entity = manager.create(ManagementExpenseItem, {
        schoolExpense,
        subject,
        ...data,
      });

      const saved = await manager.save(entity);

      if (otherCostRows.length) {
        await manager.save(
          otherCostRows.map((oc) =>
            manager.create(ManagementExpenseOtherCost, {
              managementExpenseItemId: saved.id,
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

      await manager.save(SchoolExpenseHistory, {
        schoolExpenseId: body.schoolExpenseId,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'CREATE',
        entityType: 'management_expense_item',
        newData: { ...body, otherCosts: otherCostRows },
      });

      return saved.id;
    });

    const result = await this.findOneWithOtherCosts(savedId);
    return result ? this.withOtherCosts(result) : result;
  }

  // FIND ALL
  async findAll(query: any) {
    const qb = this.managementExpenseItemRepository
      .createQueryBuilder('managementExpenseItem')
      .leftJoinAndSelect('managementExpenseItem.subject', 'subject')
      .leftJoinAndSelect('managementExpenseItem.schoolExpense', 'schoolExpense')
      .leftJoinAndSelect('managementExpenseItem.otherCosts', 'otherCosts')
      .orderBy('managementExpenseItem.rowIndex', 'ASC')
      .addOrderBy('managementExpenseItem.id', 'ASC');

    if (query.schoolExpenseId) {
      qb.andWhere('schoolExpense.id = :schoolExpenseId', {
        schoolExpenseId: query.schoolExpenseId,
      });
    }

    if (query.subjectId) {
      qb.andWhere('subject.id = :subjectId', {
        subjectId: query.subjectId,
      });
    }

    const items = await qb.getMany();
    const payments = await loadSuggestPayments(
      this.dataSource.manager,
      items.map((item) => item.id),
    );
    return items.map((i) => withSuggestPayments(this.withOtherCosts(i), payments));
  }

  // FIND ONE
  async findOne(id: number) {
    const data = await this.findOneWithOtherCosts(id);

    if (!data) {
      throw new NotFoundException('ManagementExpenseItem not found');
    }

    return withSuggestPayments(
      this.withOtherCosts(data),
      await loadSuggestPayments(this.dataSource.manager, [data.id]),
    );
  }

  // UPDATE
  async update(id: number, body: any, user?: AuthUser) {
    const data = await this.managementExpenseItemRepository.findOne({
      where: { id },
      relations: {
        schoolExpense: {
          school: true,
        },
        subject: true,
        otherCosts: true,
      },
    });

    if (!data) {
      throw new NotFoundException('ManagementExpenseItem not found');
    }

    const oldData = { ...data };

    this.assertNotLocked(data.schoolExpense, user);

    if (body.subjectId && Number(body.subjectId) !== data.subject?.id) {
      const subject = await this.subjectRepository.findOne({
        where: {
          id: Number(body.subjectId),
        },
      });

      if (!subject) {
        throw new NotFoundException('Subject not found');
      }

      if (subject.schoolId !== data.schoolExpense.school?.id) {
        throw new BadRequestException('Subject does not belong to school');
      }

      data.subject = subject;
    }

    // merged item để tính lại (body override giá trị cũ)
    const merged = {
      rowIndex: data.rowIndex,
      totalPeriods: data.totalPeriods,
      studentCount: data.studentCount,
      monthsCount: data.monthsCount,
      ql1UnitPrice: data.ql1UnitPrice,
      ql2UnitPrice: data.ql2UnitPrice,
      invoiceAmount: data.invoiceAmount,
      contractAmount: data.contractAmount,
      collectedDate: data.collectedDate,
      expenseDate: data.expenseDate,
      paidAmount: data.paidAmount,
      payer: data.payer,
      cashAccount: data.cashAccount,
      note: data.note,
      ...body,
    };

    const shared = normalizeSharedFields(merged);

    // otherCosts không gửi → giữ nguyên (nhưng tính lại amount theo studentCount/
    // monthsCount mới); gửi [] → xóa hết; gửi mảng → thay thế.
    const rawOtherCosts = Array.isArray(body.otherCosts)
      ? body.otherCosts
      : (data.otherCosts ?? []).map((oc) => ({
          policyOtherCostId: oc.policyOtherCostId,
          name: oc.name,
          unitPrice: oc.unitPrice,
          tax: oc.tax,
        }));

    const { rows: otherCostRows, totalOtherCostAmount, totalOtherTaxAmount } =
      computeOtherCostRows(rawOtherCosts, shared);

    const built = buildManagementExpenseItemData(
      merged,
      shared.rowIndex,
      merged,
      totalOtherCostAmount,
      totalOtherTaxAmount,
    );
    // Dòng có tiền từ đề xuất chi: Ngày chi / Nguồn chi / Đã chi giữ nguyên.
    const linkedRow = (
      await loadLinkedManagementRows(this.dataSource.manager, { itemIds: [id] })
    ).get(id);
    Object.assign(
      data,
      linkedRow ? keepLinkedPaymentFields(built, linkedRow, built.totalOutside) : built,
    );

    await this.assertPaidWithinOutside(
      data.schoolExpense.id,
      data.subject.id,
      { paidAmount: Number(data.paidAmount), totalOutside: Number(data.totalOutside) },
      id,
    );

    const savedId = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(ManagementExpenseItem, data);

      // Thay thế toàn bộ otherCosts của dòng (xóa cũ → tạo mới đã tính lại).
      await manager.delete(ManagementExpenseOtherCost, {
        managementExpenseItemId: saved.id,
      });

      if (otherCostRows.length) {
        await manager.save(
          otherCostRows.map((oc) =>
            manager.create(ManagementExpenseOtherCost, {
              managementExpenseItemId: saved.id,
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

      await manager.save(SchoolExpenseHistory, {
        schoolExpenseId: oldData.schoolExpense?.id,
        updatedById: user?.id,
        updatedByName: user?.name,
        action: 'UPDATE',
        entityType: 'management_expense_item',
        oldData,
        newData: { ...body, otherCosts: otherCostRows },
      });

      return saved.id;
    });

    const result = await this.findOneWithOtherCosts(savedId);
    return result ? this.withOtherCosts(result) : result;
  }

  // DELETE
  async remove(id: number, user?: AuthUser) {
    const data = await this.findOneWithOtherCosts(id);

    if (!data) {
      throw new NotFoundException('ManagementExpenseItem not found');
    }

    this.assertNotLocked(data.schoolExpense, user);

    const linkedRow = (
      await loadLinkedManagementRows(this.dataSource.manager, { itemIds: [id] })
    ).get(id);
    if (linkedRow) throw linkedRowDeleteError(linkedRow.payments);

    await this.historyRepository.save({
      schoolExpenseId: data.schoolExpense?.id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'DELETE',
      entityType: 'management_expense_item',
      oldData: data,
    });

    // FK onDelete CASCADE → tự xóa các "Chi khác" của dòng này.
    await this.managementExpenseItemRepository.remove(data);

    return {
      message: 'Deleted successfully',
    };
  }
}
