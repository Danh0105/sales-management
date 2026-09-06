import {
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { CashPolicyItem } from './cash-policy-item.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';

@Injectable()
export class CashPolicyItemsService {
    constructor(
        @InjectRepository(CashPolicyItem)
        private readonly cashPolicyRepository: Repository<CashPolicyItem>,

        @InjectRepository(SchoolExpense)
        private readonly schoolExpenseRepository: Repository<SchoolExpense>,
    ) {}

    // CREATE
    async create(body: any) {
        const schoolExpense =
            await this.schoolExpenseRepository.findOne({
                where: {
                    id: body.schoolExpenseId,
                },
            });

        if (!schoolExpense) {
            throw new NotFoundException(
                'SchoolExpense not found',
            );
        }

        const entity =
            this.cashPolicyRepository.create({
                schoolExpense,

                payer: body.payer,

                cashPolicyAmount:
                    body.cashPolicyAmount || 0,

                otherAmount:
                    body.otherAmount || 0,

                paymentDate:
                    body.paymentDate,

                note: body.note,
            });

        const saved =
            await this.cashPolicyRepository.save(
                entity,
            );

        await this.updateTotalCashPolicy(
            schoolExpense.id,
        );

        return saved;
    }

    // FIND ALL
    async findAll(query: any) {
        const qb =
            this.cashPolicyRepository
                .createQueryBuilder(
                    'cashPolicy',
                )
                .leftJoinAndSelect(
                    'cashPolicy.schoolExpense',
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
                    'cashPolicy.id',
                    'DESC',
                );

        if (query.schoolExpenseId) {
            qb.andWhere(
                'schoolExpense.id = :schoolExpenseId',
                {
                    schoolExpenseId:
                        query.schoolExpenseId,
                },
            );
        }

        return await qb.getMany();
    }

    // FIND ONE
    async findOne(id: number) {
        const data =
            await this.cashPolicyRepository.findOne({
                where: { id },

                relations: [
                    'schoolExpense',
                    'schoolExpense.school',
                    'schoolExpense.period',
                ],
            });

        if (!data) {
            throw new NotFoundException(
                'CashPolicyItem not found',
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
            await this.findOne(id);

        data.payer =
            body.payer ?? data.payer;

        data.cashPolicyAmount =
            body.cashPolicyAmount ??
            data.cashPolicyAmount;

        data.otherAmount =
            body.otherAmount ??
            data.otherAmount;

        data.paymentDate =
            body.paymentDate ??
            data.paymentDate;

        data.note =
            body.note ?? data.note;

        const saved =
            await this.cashPolicyRepository.save(
                data,
            );

        await this.updateTotalCashPolicy(
            data.schoolExpense.id,
        );

        return saved;
    }

    // DELETE
    async remove(id: number) {
        const data =
            await this.findOne(id);

        const schoolExpenseId =
            data.schoolExpense.id;

        await this.cashPolicyRepository.remove(
            data,
        );

        await this.updateTotalCashPolicy(
            schoolExpenseId,
        );

        return {
            message:
                'Deleted successfully',
        };
    }

    // UPDATE TOTAL
    async updateTotalCashPolicy(
        schoolExpenseId: number,
    ) {
        const items =
            await this.cashPolicyRepository.find({
                where: {
                    schoolExpense: {
                        id: schoolExpenseId,
                    },
                },
            });

        const total =
            items.reduce(
                (sum, item) =>
                    sum +
                    Number(
                        item.cashPolicyAmount ||
                            0,
                    ) +
                    Number(
                        item.otherAmount || 0,
                    ),
                0,
            );

        await this.schoolExpenseRepository.update(
            schoolExpenseId,
            {
                totalCashPolicy: total,
            },
        );
    }
}