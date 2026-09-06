import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ExpensePeriod } from './expense-period.entity';

@Injectable()
export class ExpensePeriodsService {
    constructor(
        @InjectRepository(ExpensePeriod)
        private readonly expensePeriodRepository: Repository<ExpensePeriod>,
    ) {}

    // CREATE
    async create(body: any) {
        const existed =
            await this.expensePeriodRepository.findOne({
                where: {
                    month: body.month,
                    year: body.year,
                },
            });

        if (existed) {
            throw new BadRequestException(
                'Expense period already exists',
            );
        }

        const entity =
            this.expensePeriodRepository.create({
                month: body.month,

                year: body.year,

                name:
                    body.name ||
                    `Tháng ${body.month}/${body.year}`,

                status:
                    body.status || 1,
            });

        return await this.expensePeriodRepository.save(
            entity,
        );
    }

    // FIND ALL
    async findAll(query: any) {
        const qb =
            this.expensePeriodRepository
                .createQueryBuilder(
                    'expensePeriod',
                )
                .leftJoinAndSelect(
                    'expensePeriod.schoolExpenses',
                    'schoolExpenses',
                )
                .orderBy(
                    'expensePeriod.year',
                    'DESC',
                )
                .addOrderBy(
                    'expensePeriod.month',
                    'DESC',
                );

        if (query.month) {
            qb.andWhere(
                'expensePeriod.month = :month',
                {
                    month: query.month,
                },
            );
        }

        if (query.year) {
            qb.andWhere(
                'expensePeriod.year = :year',
                {
                    year: query.year,
                },
            );
        }

        if (query.status) {
            qb.andWhere(
                'expensePeriod.status = :status',
                {
                    status: query.status,
                },
            );
        }

        return await qb.getMany();
    }

    // FIND ONE
    async findOne(id: number) {
        const data =
            await this.expensePeriodRepository.findOne({
                where: {
                    id,
                },

                relations: [
                    'schoolExpenses',
                    'schoolExpenses.school',
                    'schoolExpenses.expenseItems',
                    'schoolExpenses.cashPolicyItems',
                ],
            });

        if (!data) {
            throw new NotFoundException(
                'ExpensePeriod not found',
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

        if (
            body.month &&
            body.year
        ) {
            const existed =
                await this.expensePeriodRepository.findOne({
                    where: {
                        month: body.month,
                        year: body.year,
                    },
                });

            if (
                existed &&
                existed.id !== id
            ) {
                throw new BadRequestException(
                    'Expense period already exists',
                );
            }
        }

        data.month =
            body.month ?? data.month;

        data.year =
            body.year ?? data.year;

        data.name =
            body.name ?? data.name;

        data.status =
            body.status ?? data.status;

        return await this.expensePeriodRepository.save(
            data,
        );
    }

    // DELETE
    async remove(id: number) {
        const data =
            await this.findOne(id);

        await this.expensePeriodRepository.remove(
            data,
        );

        return {
            message:
                'Deleted successfully',
        };
    }

    // LOCK PERIOD
    async lock(id: number) {
        const data =
            await this.findOne(id);

        data.status = 2;

        return await this.expensePeriodRepository.save(
            data,
        );
    }

    // OPEN PERIOD
    async open(id: number) {
        const data =
            await this.findOne(id);

        data.status = 1;

        return await this.expensePeriodRepository.save(
            data,
        );
    }
}