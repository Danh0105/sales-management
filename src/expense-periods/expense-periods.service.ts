import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';

import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository } from 'typeorm';

import { ExpensePeriod } from './expense-period.entity';
import { SchoolExpense } from '../school-expenses/entities/school-expenses.entity';
import { RevenueItem } from '../revenue-item/revenue-item.entity';
import { SchoolExpenseItem } from '../school-expense-item/school-expense-item.entity';
import { ManagementExpenseItem } from '../management-expense-item/management-expense-item.entity';
import { ManagementExpenseOtherCost } from '../management-expense-item/management-expense-other-cost.entity';

@Injectable()
export class ExpensePeriodsService {
    constructor(
        @InjectRepository(ExpensePeriod)
        private readonly expensePeriodRepository: Repository<ExpensePeriod>,
        private readonly dataSource: DataSource,
    ) {}

    // CREATE
    async create(body: any) {
        // Mỗi trường có danh sách kỳ RIÊNG — schoolId quyết định phạm vi
        // check trùng + cấp số tháng ảo, không còn dùng chung giữa các trường.
        const schoolId = body.schoolId ? Number(body.schoolId) : null;

        // Dòng tuỳ chỉnh (không truyền month) — backend tự cấp 1 số tháng
        // "ảo" (> 12) chưa dùng trong cùng năm của TRƯỜNG này, tránh đụng độ
        // 12 tháng thật và tránh race-condition nếu để FE tự tính.
        let month = body.month;

        if (!month) {
            const virtualPeriods =
                await this.expensePeriodRepository
                    .createQueryBuilder('expensePeriod')
                    .where('expensePeriod.year = :year', {
                        year: body.year,
                    })
                    .andWhere('expensePeriod.month > 12')
                    .andWhere(
                        schoolId
                            ? 'expensePeriod.school_id = :schoolId'
                            : 'expensePeriod.school_id IS NULL',
                        { schoolId },
                    )
                    .orderBy('expensePeriod.month', 'DESC')
                    .getMany();

            month = virtualPeriods.length
                ? virtualPeriods[0].month + 1
                : 13;
        } else {
            // Không dùng where: { school: { id } } — TypeORM không lọc chắc
            // chắn theo quan hệ nullable này, dễ khớp nhầm với các kỳ cũ
            // dùng chung (school_id NULL) từ trước khi có tính năng theo
            // trường. Lọc trực tiếp theo cột school_id bằng query builder.
            const existed = await this.expensePeriodRepository
                .createQueryBuilder('expensePeriod')
                .where('expensePeriod.month = :month', { month })
                .andWhere('expensePeriod.year = :year', { year: body.year })
                .andWhere(
                    schoolId
                        ? 'expensePeriod.school_id = :schoolId'
                        : 'expensePeriod.school_id IS NULL',
                    { schoolId },
                )
                .getOne();

            // Idempotent: FE có thể gọi tạo cùng 1 kỳ nhiều lần gần như đồng
            // thời (mở trường + đổi tháng + đổi năm học) — trả luôn kỳ đã có
            // thay vì báo lỗi 400.
            if (existed) {
                return existed;
            }
        }

        const entity =
            this.expensePeriodRepository.create({
                month,

                year: body.year,

                name:
                    body.name ||
                    `Tháng ${month}/${body.year}`,

                status:
                    body.status || 1,

                school: schoolId ? ({ id: schoolId } as any) : null,
            });

        try {
            return await this.expensePeriodRepository.save(entity);
        } catch (error: any) {
            // 2 request chạy song song cùng vượt qua bước check ở trên →
            // unique index (school_id, month, year) chặn bản thứ 2; trả về
            // bản đã được request kia tạo.
            if (error?.code === '23505' && schoolId) {
                const existed = await this.expensePeriodRepository
                    .createQueryBuilder('expensePeriod')
                    .where('expensePeriod.month = :month', { month })
                    .andWhere('expensePeriod.year = :year', { year: body.year })
                    .andWhere('expensePeriod.school_id = :schoolId', { schoolId })
                    .getOne();

                if (existed) return existed;
            }

            throw error;
        }
    }

    // FIND ALL
    async findAll(query: any) {
        const qb =
            this.expensePeriodRepository
                .createQueryBuilder(
                    'expensePeriod',
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

        // Mỗi trường có danh sách kỳ riêng — bắt buộc lọc theo schoolId khi
        // FE muốn xem sidebar theo trường (không truyền = xem tất cả, dùng
        // cho các màn thống kê tổng hợp).
        if (query.schoolId) {
            qb.andWhere('expensePeriod.school_id = :schoolId', {
                schoolId: Number(query.schoolId),
            });
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
            // Chỉ check trùng trong phạm vi trường của kỳ này — mỗi trường
            // có danh sách kỳ riêng.
            const current = await this.expensePeriodRepository
                .createQueryBuilder('expensePeriod')
                .select('expensePeriod.school_id', 'schoolId')
                .where('expensePeriod.id = :id', { id })
                .getRawOne();

            const existed = await this.expensePeriodRepository
                .createQueryBuilder('expensePeriod')
                .where('expensePeriod.month = :month', { month: body.month })
                .andWhere('expensePeriod.year = :year', { year: body.year })
                .andWhere(
                    'expensePeriod.school_id IS NOT DISTINCT FROM :schoolId',
                    { schoolId: current?.schoolId ?? null },
                )
                .getOne();

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

    // DUPLICATE — nhân bản 1 kỳ chi phí kèm TOÀN BỘ dữ liệu thu chi
    // (Doanh Thu, Chi Trường, Chi Ngoài + Chi khác) của tất cả các trường
    // trong kỳ gốc sang 1 kỳ mới.
    async duplicate(id: number, body?: { name?: string }) {
        const source = await this.expensePeriodRepository.findOne({
            where: { id },
            relations: ['school'],
        });

        if (!source) {
            throw new NotFoundException('ExpensePeriod not found');
        }

        return this.dataSource.transaction(async (manager) => {
            // 1. Tạo kỳ mới — tự cấp tháng ảo (>12) trong cùng năm CỦA CÙNG
            // TRƯỜNG với kỳ gốc, tránh trùng (month, year, school) với kỳ
            // gốc và các kỳ khác của trường đó.
            const schoolId = source.school?.id || null;
            const virtualPeriods = await manager
                .createQueryBuilder(ExpensePeriod, 'expensePeriod')
                .where('expensePeriod.year = :year', { year: source.year })
                .andWhere('expensePeriod.month > 12')
                .andWhere(
                    schoolId
                        ? 'expensePeriod.school_id = :schoolId'
                        : 'expensePeriod.school_id IS NULL',
                    { schoolId },
                )
                .orderBy('expensePeriod.month', 'DESC')
                .getMany();

            const newMonth = virtualPeriods.length
                ? virtualPeriods[0].month + 1
                : 13;

            const newPeriod = await manager.save(
                manager.create(ExpensePeriod, {
                    month: newMonth,
                    year: source.year,
                    name:
                        body?.name?.trim() ||
                        `${source.name || `Tháng ${source.month}/${source.year}`} (bản sao)`,
                    status: 1,
                    school: source.school || null,
                }),
            );

            // 2. Lấy toàn bộ school_expenses của kỳ gốc kèm dữ liệu con.
            const sourceExpenses = await manager.find(SchoolExpense, {
                where: { period: { id: source.id } },
                relations: [
                    'school',
                    'revenueItems',
                    'revenueItems.subject',
                    'schoolExpenseItems',
                    'schoolExpenseItems.subject',
                    'managementExpenseItems',
                    'managementExpenseItems.subject',
                    'managementExpenseItems.otherCosts',
                ],
            });

            for (const sourceExpense of sourceExpenses) {
                const { id: _oldId, ...schoolExpenseData } = sourceExpense;

                const newSchoolExpense = await manager.save(
                    manager.create(SchoolExpense, {
                        ...schoolExpenseData,
                        period: newPeriod,
                        school: sourceExpense.school,
                        // Kỳ mới cần được xác nhận lại — không kế thừa khoá
                        // "Chi Ngoài" của kỳ gốc.
                        managementExpenseConfirmed: false,
                        managementExpenseConfirmedBy: null,
                        managementExpenseConfirmedByName: null,
                        managementExpenseConfirmedAt: null,
                        revenueItems: undefined,
                        schoolExpenseItems: undefined,
                        managementExpenseItems: undefined,
                    }),
                );

                for (const item of sourceExpense.revenueItems || []) {
                    const { id: _itemId, schoolExpense: _se, ...rest } = item;
                    await manager.save(
                        manager.create(RevenueItem, {
                            ...rest,
                            schoolExpense: newSchoolExpense,
                            subject: item.subject,
                        }),
                    );
                }

                for (const item of sourceExpense.schoolExpenseItems || []) {
                    const { id: _itemId, schoolExpense: _se, ...rest } = item;
                    await manager.save(
                        manager.create(SchoolExpenseItem, {
                            ...rest,
                            schoolExpense: newSchoolExpense,
                            subject: item.subject,
                        }),
                    );
                }

                for (const item of sourceExpense.managementExpenseItems || []) {
                    const {
                        id: _itemId,
                        schoolExpense: _se,
                        otherCosts,
                        ...rest
                    } = item;

                    const newItem = await manager.save(
                        manager.create(ManagementExpenseItem, {
                            ...rest,
                            schoolExpense: newSchoolExpense,
                            subject: item.subject,
                        }),
                    );

                    for (const cost of otherCosts || []) {
                        const {
                            id: _costId,
                            managementExpenseItem: _mei,
                            managementExpenseItemId: _meiId,
                            ...costRest
                        } = cost;

                        await manager.save(
                            manager.create(ManagementExpenseOtherCost, {
                                ...costRest,
                                managementExpenseItem: newItem,
                            }),
                        );
                    }
                }
            }

            return manager.findOne(ExpensePeriod, {
                where: { id: newPeriod.id },
            });
        });
    }

    // DELETE
    async remove(id: number) {
        // Không dùng findOne() ở đây — nó LEFT JOIN nhiều quan hệ OneToMany
        // cùng lúc (schoolExpenses.expenseItems × schoolExpenses.cashPolicyItems),
        // gây nhân bản dòng kiểu tích Descartes khi 1 kỳ có nhiều trường/nhiều
        // dòng dữ liệu, dễ khiến truy vấn phình to và timeout với các kỳ đã
        // có sẵn nhiều dữ liệu thực tế. DELETE FROM expense_periods cascade
        // xuống toàn bộ bảng con ở tầng DB (ON DELETE CASCADE), không cần
        // load quan hệ trước.
        const exists = await this.expensePeriodRepository.exist({
            where: { id },
        });

        if (!exists) {
            throw new NotFoundException('ExpensePeriod not found');
        }

        try {
            await this.expensePeriodRepository.delete(id);
        } catch (error) {
            console.error('Failed to delete expense period', id, error);
            throw new BadRequestException(
                'Không thể xoá kỳ chi phí này: ' +
                    (error?.message || 'Lỗi không xác định'),
            );
        }

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