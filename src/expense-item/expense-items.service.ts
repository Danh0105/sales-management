import {
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ExpenseItem } from './expense-item.entity';
import { Subject } from '../subject/subject.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Injectable()
export class ExpenseItemsService {
    constructor(
        @InjectRepository(ExpenseItem)
        private readonly expenseItemRepository: Repository<ExpenseItem>,

        @InjectRepository(SchoolExpense)
        private readonly schoolExpenseRepository: Repository<SchoolExpense>,

        @InjectRepository(Subject)
        private readonly subjectRepository: Repository<Subject>,
    ) {}

    // CREATE
    async create(body: any) {
        const [
            schoolExpense,
            subject,
        ] = await Promise.all([
            this.schoolExpenseRepository.findOne({
                where: {
                    id: body.schoolExpenseId,
                },
            }),
    
            this.subjectRepository.findOne({
                where: {
                    id: body.subjectId,
                },
            }),
        ]);
    
        if (!schoolExpense) {
            throw new NotFoundException(
                'SchoolExpense not found',
            );
        }
    
        if (!subject) {
            throw new NotFoundException(
                'Subject not found',
            );
        }
    
        const revenueAmount = Number(
            body.revenueAmount || 0,
        );
    
        const expenseAmount = Number(
            body.expenseAmount || 0,
        );
    
        const entity =
        this.expenseItemRepository.create({
            schoolExpense,
    
            subject,
    
            totalPeriods: Number(
                body.totalPeriods || 0,
            ),
    
            // số học sinh
            studentCount: Number(
                body.studentCount || 0,
            ),
    
            revenueAmount: Number(
                body.revenueAmount || 0,
            ),
    
            invoiceAmount: Number(
                body.invoiceAmount || 0,
            ),
    
            collectedDate:
                body.collectedDate || null,
    
            totalOutsideExpense: Number(
                body.totalOutsideExpense || 0,
            ),
    
            paidAmount: Number(
                body.paidAmount || 0,
            ),
    
            remainingOutsideExpense:
                Number(
                    body.remainingOutsideExpense ||
                        0,
                ),
    
            expenseAmount: Number(
                body.expenseAmount || 0,
            ),
    
            paymentDate:
                body.paymentDate || null,
    
            payer: body.payer || '',
    
            note: body.note || '',
        });
    
        const saved =
            await this.expenseItemRepository.save(
                entity,
            );
    
        await this.updateSchoolExpenseTotal(
            schoolExpense.id,
        );
    
        return await this.expenseItemRepository.findOne(
            {
                where: {
                    id: saved.id,
                },
    
                relations: {
                    subject: true,
                    schoolExpense: true,
                },
            },
        );
    }

    // FIND ALL
    async findAll(query: any) {
        const {
            page = 1,
            limit = 10,
            schoolId,
            periodId,
        } = query;
    
        const qb =
            this.expenseItemRepository
                .createQueryBuilder(
                    'expenseItem',
                )
    
                .leftJoinAndSelect(
                    'expenseItem.subject',
                    'subject',
                )
    
                .leftJoinAndSelect(
                    'expenseItem.schoolExpense',
                    'schoolExpense',
                )
    
                .leftJoinAndSelect(
                    'schoolExpense.school',
                    'school',
                )
    
                .leftJoinAndSelect(
                    'schoolExpense.period',
                    'period',
                )
    
                .orderBy(
                    'expenseItem.id',
                    'DESC',
                );
    
        // FILTER SCHOOL
        if (schoolId) {
            qb.andWhere(
                'school.id = :schoolId',
                {
                    schoolId,
                },
            );
        }
    
        // FILTER PERIOD
        if (periodId) {
            qb.andWhere(
                'period.id = :periodId',
                {
                    periodId,
                },
            );
        }
    
        qb.skip((page - 1) * limit);
    
        qb.take(limit);
    
        const [data, total] =
            await qb.getManyAndCount();
        return {
            data,
            total,
            page: Number(page),
            limit: Number(limit),
            totalPages: Math.ceil(
                total / limit,
            ),
        };
    }

    // FIND ONE
    async findOne(id: number) {
        const data =
            await this.expenseItemRepository.findOne({
                where: {
                    id,
                },

                relations: [
                    'subject',
                    'schoolExpense',
                    'schoolExpense.school',
                    'schoolExpense.period',
                ],
            });

        if (!data) {
            throw new NotFoundException(
                'ExpenseItem not found',
            );
        }

        return data;
    }

    // UPDATE
    async update(
        id: number,
        body: any,
    ) {
        const data =
            await this.expenseItemRepository.findOne({
                where: {
                    id,
                },
    
                relations: {
                    schoolExpense: true,
                    subject: true,
                },
            });
    
        if (!data) {
            throw new NotFoundException(
                'ExpenseItem not found',
            );
        }
    
        // UPDATE SUBJECT
        if (
            body.subjectId &&
            Number(body.subjectId) !==
                data.subject?.id
        ) {
            const subject =
                await this.subjectRepository.findOne({
                    where: {
                        id: Number(
                            body.subjectId,
                        ),
                    },
                });
    
            if (!subject) {
                throw new NotFoundException(
                    'Subject not found',
                );
            }
    
            data.subject = subject;
        }
    
        // UPDATE DATA
    
        if (
            body.totalPeriods !== undefined
        ) {
            data.totalPeriods = Number(
                body.totalPeriods || 0,
            );
        }
    
        if (
            body.studentCount !== undefined
        ) {
            data.studentCount = Number(
                body.studentCount || 0,
            );
        }
    
        if (
            body.invoiceAmount !== undefined
        ) {
            data.invoiceAmount = Number(
                body.invoiceAmount || 0,
            );
        }
    
        if (
            body.collectedDate !== undefined
        ) {
            data.collectedDate =
                body.collectedDate || null;
        }
    
        if (
            body.totalOutsideExpense !==
            undefined
        ) {
            data.totalOutsideExpense = Number(
                body.totalOutsideExpense || 0,
            );
        }
    
        if (
            body.paidAmount !== undefined
        ) {
            data.paidAmount = Number(
                body.paidAmount || 0,
            );
        }
    
        if (
            body.remainingOutsideExpense !==
            undefined
        ) {
            data.remainingOutsideExpense =
                Number(
                    body.remainingOutsideExpense ||
                        0,
                );
        }
    
        if (
            body.revenueAmount !== undefined
        ) {
            data.revenueAmount = Number(
                body.revenueAmount || 0,
            );
        }
    
        if (
            body.expenseAmount !== undefined
        ) {
            data.expenseAmount = Number(
                body.expenseAmount || 0,
            );
        }
    
        if (
            body.paymentDate !== undefined
        ) {
            data.paymentDate =
                body.paymentDate || null;
        }
    
        if (body.payer !== undefined) {
            data.payer = body.payer || '';
        }
    
        if (body.note !== undefined) {
            data.note = body.note || '';
        }
    
        const saved =
            await this.expenseItemRepository.save(
                data,
            );
    
        // UPDATE TOTAL
        await this.updateSchoolExpenseTotal(
            data.schoolExpense.id,
        );
    
        return await this.expenseItemRepository.findOne(
            {
                where: {
                    id: saved.id,
                },
    
                relations: {
                    subject: true,
                    schoolExpense: true,
                },
            },
        );
    }

    // DELETE
    async remove(id: number) {
        const data =
            await this.findOne(id);

        const schoolExpenseId =
            data.schoolExpense.id;

        await this.expenseItemRepository.remove(
            data,
        );

        await this.updateSchoolExpenseTotal(
            schoolExpenseId,
        );

        return {
            message:
                'Deleted successfully',
        };
    }

    // UPDATE TOTAL
    async updateSchoolExpenseTotal(
        schoolExpenseId: number,
    ) {
        const items =
            await this.expenseItemRepository.find({
                where: {
                    schoolExpense: {
                        id: schoolExpenseId,
                    },
                },
            });

        const totalRevenue =
            items.reduce(
                (sum, item) =>
                    sum +
                    Number(
                        item.revenueAmount ||
                            0,
                    ),
                0,
            );

        const totalExpense =
            items.reduce(
                (sum, item) =>
                    sum +
                    Number(
                        item.expenseAmount ||
                            0,
                    ),
                0,
            );

        await this.schoolExpenseRepository.update(
            schoolExpenseId,
            {
                totalRevenue,
                totalExpense,
            },
        );
    }
}