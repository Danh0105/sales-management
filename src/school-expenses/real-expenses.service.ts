import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

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
  buildManagementExpenseItemData,
  buildRevenueItemData,
  buildSchoolExpenseItemData,
  computeOtherCostRows,
  normalizeSharedFields,
} from './expense-calculations';
import { AuthUser } from '../type/auth-user.type';

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
      },
    });

    if (!schoolExpense) {
      throw new NotFoundException('SchoolExpense not found');
    }

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
        })),
      );
    }

    const queryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Delete old items for this subject
      await queryRunner.manager.delete(RevenueItem, {
        schoolExpense: {
          id: schoolExpenseId,
        },
        subject: {
          id: body.subjectId,
        },
      });

      await queryRunner.manager.delete(SchoolExpenseItem, {
        schoolExpense: {
          id: schoolExpenseId,
        },
        subject: {
          id: body.subjectId,
        },
      });

      await queryRunner.manager.delete(ManagementExpenseItem, {
        schoolExpense: {
          id: schoolExpenseId,
        },
        subject: {
          id: body.subjectId,
        },
      });

      const revenueItems = Array.isArray(body.revenueItems)
        ? body.revenueItems
        : [];
      const schoolExpenseItems = Array.isArray(body.schoolExpenseItems)
        ? body.schoolExpenseItems
        : [];
      const managementExpenseItems = Array.isArray(body.managementExpenseItems)
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
          ...buildRevenueItemData(item, index, sharedItems[index]),
        });

        await queryRunner.manager.save(entity);
      }

      // Create school expense items
      for (const [index, item] of schoolExpenseItems.entries()) {
        const entity = queryRunner.manager.create(SchoolExpenseItem, {
          schoolExpense,
          subject,
          ...buildSchoolExpenseItemData(item, index, sharedItems[index]),
        });

        await queryRunner.manager.save(entity);
      }

      // Create management expense items (+ Chi khác của từng dòng)
      const newManagementSnapshot: any[] = [];
      for (const [index, item] of managementExpenseItems.entries()) {
        const shared = normalizeSharedFields(sharedItems[index], index);
        const rowIndex = shared.rowIndex;

        // otherCosts undefined → giữ dữ liệu cũ theo rowIndex; [] → xóa hết.
        const rawOtherCosts = Array.isArray(item?.otherCosts)
          ? item.otherCosts
          : oldOtherCostsByRow.get(rowIndex) ?? [];

        const { rows: otherCostRows, totalOtherCostAmount, totalOtherTaxAmount } =
          computeOtherCostRows(rawOtherCosts, shared);

        const entity = queryRunner.manager.create(ManagementExpenseItem, {
          schoolExpense,
          subject,
          ...buildManagementExpenseItemData(
            item,
            index,
            sharedItems[index],
            totalOtherCostAmount,
            totalOtherTaxAmount,
          ),
        });

        const savedItem = await queryRunner.manager.save(entity);

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

        newManagementSnapshot.push({ ...item, rowIndex, otherCosts: otherCostRows });
      }

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
        },
        newData: {
          subjectId: body.subjectId,
          revenueItems,
          schoolExpenseItems,
          // Kèm Chi khác đã tính (đơn giá + thành tiền) để suy ra lịch sử thay đổi.
          managementExpenseItems: newManagementSnapshot,
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

    return {
      revenueItems,
      schoolExpenseItems,
      managementExpenseItems: managementExpenseItems.map((i) =>
        this.withOtherCosts(i),
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

    const totalSchoolExpense = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.schoolExpenseAmount || 0),
      0,
    );

    const totalSchoolExpensePaid = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.paidAmount || 0),
      0,
    );

    const totalSchoolExpenseRemaining = schoolExpenseItems.reduce(
      (sum, item) => sum + Number(item.remaining || 0),
      0,
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
      invoiceDate: i.invoiceDate,
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
      },
    };
  }
}
