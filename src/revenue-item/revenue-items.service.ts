import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { RevenueItem } from './revenue-item.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { SchoolExpenseHistory } from '../school-expenses/entities/school-expense-history.entity';
import { buildRevenueItemData } from '../school-expenses/expense-calculations';
import { AuthUser } from '../type/auth-user.type';

@Injectable()
export class RevenueItemsService {
  constructor(
    @InjectRepository(RevenueItem)
    private readonly revenueItemRepository: Repository<RevenueItem>,

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

    const entity = this.revenueItemRepository.create({
      schoolExpense,
      subject,
      ...buildRevenueItemData(body),
    });

    const saved = await this.revenueItemRepository.save(entity);

    await this.historyRepository.save({
      schoolExpenseId: body.schoolExpenseId,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'CREATE',
      entityType: 'revenue_item',
      newData: body,
    });

    return await this.revenueItemRepository.findOne({
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
    const qb = this.revenueItemRepository
      .createQueryBuilder('revenueItem')
      .leftJoinAndSelect('revenueItem.subject', 'subject')
      .leftJoinAndSelect('revenueItem.schoolExpense', 'schoolExpense')
      .orderBy('revenueItem.rowIndex', 'ASC')
      .addOrderBy('revenueItem.id', 'ASC');

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
    const data = await this.revenueItemRepository.findOne({
      where: { id },
      relations: ['subject', 'schoolExpense'],
    });

    if (!data) {
      throw new NotFoundException('RevenueItem not found');
    }

    return data;
  }

  // UPDATE
  async update(id: number, body: any, user?: AuthUser) {
    const data = await this.revenueItemRepository.findOne({
      where: { id },
      relations: {
        schoolExpense: {
          school: true,
        },
        subject: true,
      },
    });

    if (!data) {
      throw new NotFoundException('RevenueItem not found');
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
      buildRevenueItemData({
        rowIndex: data.rowIndex,
        content: data.content,
        totalPeriods: data.totalPeriods,
        studentCount: data.studentCount,
        monthsCount: data.monthsCount,
        unitPrice: data.unitPrice,
        invoiced: data.invoiced,
        invoiceType: data.invoiceType,
        invoiceOther: data.invoiceOther,
        invoiceNumber: data.invoiceNumber,
        invoiceDate: data.invoiceDate,
        paidAmount: data.paidAmount,
        paymentMethod: data.paymentMethod,
        paymentDate: data.paymentDate,
        ...body,
      }),
    );

    const saved = await this.revenueItemRepository.save(data);

    await this.historyRepository.save({
      schoolExpenseId: oldData.schoolExpense?.id,
      updatedById: user?.id,
      updatedByName: user?.name,
      action: 'UPDATE',
      entityType: 'revenue_item',
      oldData,
      newData: body,
    });

    return await this.revenueItemRepository.findOne({
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
      entityType: 'revenue_item',
      oldData: data,
    });

    await this.revenueItemRepository.remove(data);

    return {
      message: 'Deleted successfully',
    };
  }
}
