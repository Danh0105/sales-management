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
import { buildSchoolExpenseItemData } from '../school-expenses/expense-calculations';
import { AuthUser } from '../type/auth-user.type';

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

    return await qb.getMany();
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

    Object.assign(
      data,
      buildSchoolExpenseItemData({
        rowIndex: data.rowIndex,
        totalPeriods: data.totalPeriods,
        studentCount: data.studentCount,
        monthsCount: data.monthsCount,
        giaovien: data.giaovien,
        thue: data.thue,
        csvc: data.csvc,
        expenseDate: data.expenseDate,
        paidAmount: data.paidAmount,
        payer: data.payer,
        note: data.note,
        ...body,
      }),
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
