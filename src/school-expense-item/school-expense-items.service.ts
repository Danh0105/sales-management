import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { SchoolExpenseItem } from './school-expense-item.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';
import {
  assertNotFinalized,
  buildSchoolExpenseItemData,
} from '../school-expenses/expense-calculations';
import { AuthUser } from '../type/auth-user.type';
import {
  keepLinkedPaymentFields,
  linkedRowDeleteError,
  loadLinkedManagementRows,
  loadSuggestPayments,
  withSuggestPayments,
} from '../management-expense-item/suggest-payments';

@Injectable()
export class SchoolExpenseItemsService {
  constructor(
    @InjectRepository(SchoolExpenseItem)
    private readonly schoolExpenseItemRepository: Repository<SchoolExpenseItem>,

    @InjectRepository(SchoolExpense)
    private readonly schoolExpenseRepository: Repository<SchoolExpense>,

    @InjectRepository(Subject)
    private readonly subjectRepository: Repository<Subject>,

    @InjectRepository(SchoolExpenseHistory)
    private readonly historyRepository: Repository<SchoolExpenseHistory>,
  ) {}

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

    assertNotFinalized(schoolExpense);

    if (!subject) {
      throw new NotFoundException('Subject not found');
    }

    if (subject.schoolId !== schoolExpense.school?.id) {
      throw new BadRequestException('Subject does not belong to school');
    }

    const entity = this.schoolExpenseItemRepository.create({
      schoolExpense,
      subject,
      ...buildSchoolExpenseItemData(body),
    });

    const saved = await this.schoolExpenseItemRepository.save(entity);

    await this.historyRepository.save({
      schoolExpenseId: body.schoolExpenseId,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'CREATE',
      entityType: 'school_expense_item',
      newData: body,
    });

    return await this.schoolExpenseItemRepository.findOne({
      where: {
        id: saved.id,
      },
      relations: {
        subject: true,
        schoolExpense: true,
      },
    });
  }

  // FIND ALL
  async findAll(query: any) {
    const qb = this.schoolExpenseItemRepository
      .createQueryBuilder('schoolExpenseItem')
      .leftJoinAndSelect('schoolExpenseItem.subject', 'subject')
      .leftJoinAndSelect('schoolExpenseItem.schoolExpense', 'schoolExpense')
      .orderBy('schoolExpenseItem.rowIndex', 'ASC')
      .addOrderBy('schoolExpenseItem.id', 'ASC');

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

    // Dòng có Đã chi từ Đề xuất Chi Trường: Ngày chi / Nguồn chi hiện lần ghi
    // gần nhất kèm mã đề xuất để màn hình khoá ô (như Chi Ngoài).
    const items = await qb.getMany();
    const payments = await loadSuggestPayments(
      this.schoolExpenseItemRepository.manager,
      items.map((item) => item.id),
      'SCHOOL_EXPENSE',
    );
    return items.map((item) => withSuggestPayments(item, payments));
  }

  // FIND ONE
  async findOne(id: number) {
    const data = await this.schoolExpenseItemRepository.findOne({
      where: { id },
      relations: ['subject', 'schoolExpense'],
    });

    if (!data) {
      throw new NotFoundException('SchoolExpenseItem not found');
    }

    return data;
  }

  /** Một dòng cho màn hình — kèm phần Đã chi từ đề xuất như danh sách. */
  async findOneView(id: number) {
    const data = await this.findOne(id);
    return withSuggestPayments(
      data,
      await loadSuggestPayments(
        this.schoolExpenseItemRepository.manager,
        [data.id],
        'SCHOOL_EXPENSE',
      ),
    );
  }

  // UPDATE
  async update(id: number, body: any, user?: AuthUser) {
    const data = await this.schoolExpenseItemRepository.findOne({
      where: { id },
      relations: {
        schoolExpense: {
          school: true,
        },
        subject: true,
      },
    });

    if (!data) {
      throw new NotFoundException('SchoolExpenseItem not found');
    }

    assertNotFinalized(data.schoolExpense);

    const oldData = { ...data };

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

    // Dòng có Đã chi từ Đề xuất Chi Trường: Ngày chi / Nguồn chi / Đã chi giữ số trên server.
    const linkedRow = (
      await loadLinkedManagementRows(
        this.schoolExpenseItemRepository.manager,
        { itemIds: [id] },
        'SCHOOL_EXPENSE',
      )
    ).get(id);

    const built = buildSchoolExpenseItemData({
      rowIndex: data.rowIndex,
      totalPeriods: data.totalPeriods,
      studentCount: data.studentCount,
      monthsCount: data.monthsCount,
      giaovien: data.giaovien,
      thue: data.thue,
      csvc: data.csvc,
      expenseDate: data.expenseDate,
      paidAmount: data.paidAmount,
      paymentType: data.paymentType,
      cashAccount: data.cashAccount,
      payer: data.payer,
      note: data.note,
      ...body,
    });
    Object.assign(
      data,
      linkedRow
        ? keepLinkedPaymentFields(built, linkedRow, built.schoolExpenseAmount)
        : built,
    );

    const saved = await this.schoolExpenseItemRepository.save(data);

    await this.historyRepository.save({
      schoolExpenseId: oldData.schoolExpense?.id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'UPDATE',
      entityType: 'school_expense_item',
      oldData,
      newData: body,
    });

    return await this.schoolExpenseItemRepository.findOne({
      where: {
        id: saved.id,
      },
      relations: {
        subject: true,
        schoolExpense: true,
      },
    });
  }

  // DELETE
  async remove(id: number, user?: AuthUser) {
    const data = await this.findOne(id);

    assertNotFinalized(data.schoolExpense);

    const linkedRow = (
      await loadLinkedManagementRows(
        this.schoolExpenseItemRepository.manager,
        { itemIds: [id] },
        'SCHOOL_EXPENSE',
      )
    ).get(id);
    if (linkedRow)
      throw linkedRowDeleteError(linkedRow.payments, 'SCHOOL_EXPENSE');

    await this.historyRepository.save({
      schoolExpenseId: data.schoolExpense?.id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'DELETE',
      entityType: 'school_expense_item',
      oldData: data,
    });

    await this.schoolExpenseItemRepository.remove(data);

    return {
      message: 'Deleted successfully',
    };
  }
}
