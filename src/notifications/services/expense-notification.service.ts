import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';

import { Notification } from '../entities/notification.entity';
import { NotificationType } from '../enums/notification-type.enum';

/**
 * Thông báo đề xuất chi được lưu type = SUGGEST, phân biệt bằng
 * meta.suggestType = 'EXPENSE_REQUEST'. Service này chỉ thao tác trên tập đó.
 *
 * - scope = 'general'  → mọi thông báo TRỪ cảnh báo quá hạn (tab thường).
 * - scope = 'overdue'  → chỉ cảnh báo quá hạn (meta.kind = 'overdue') → tab riêng.
 * - scope = 'all'      → không lọc theo kind.
 *
 * "Nhân viên kinh doanh" của thông báo = meta.employeeId (người tạo đề xuất).
 */
export type ExpenseNotiScope = 'general' | 'overdue' | 'all';

const EXPENSE_SUGGEST_TYPE = 'EXPENSE_REQUEST';
const OVERDUE_KIND = 'overdue';

@Injectable()
export class ExpenseNotificationService {
    constructor(
        @InjectRepository(Notification)
        private readonly repo: Repository<Notification>,
    ) { }

    private normalizeScope(scope?: string): ExpenseNotiScope {
        return scope === 'overdue' || scope === 'all' ? scope : 'general';
    }

    /** Ràng buộc chung: đúng receiver + là thông báo đề xuất chi + scope/tab. */
    private applyFilters(
        qb: SelectQueryBuilder<Notification>,
        opts: {
            receiverId: number;
            scope: ExpenseNotiScope;
            tab?: 'unread' | 'read';
            employeeId?: number;
        },
    ) {
        qb.where('n."receiverId" = :receiverId', { receiverId: opts.receiverId })
            .andWhere('n.type = :type', { type: NotificationType.SUGGEST })
            .andWhere(`n.meta->>'suggestType' = :st`, { st: EXPENSE_SUGGEST_TYPE });

        if (opts.scope === 'overdue') {
            qb.andWhere(`n.meta->>'kind' = :ovk`, { ovk: OVERDUE_KIND });
        } else if (opts.scope === 'general') {
            qb.andWhere(`(n.meta->>'kind' IS DISTINCT FROM :ovk)`, { ovk: OVERDUE_KIND });
        }

        if (opts.tab === 'unread') qb.andWhere('n."isRead" = false');
        else if (opts.tab === 'read') qb.andWhere('n."isRead" = true');

        if (opts.employeeId != null) {
            qb.andWhere(`(n.meta->>'employeeId')::int = :employeeId`, {
                employeeId: opts.employeeId,
            });
        }

        return qb;
    }

    /** Đếm cho badge tab: tổng & chưa đọc theo từng scope. */
    async summary(receiverId: number) {
        const rows = await this.repo
            .createQueryBuilder('n')
            .select(
                `CASE WHEN n.meta->>'kind' = :ovk THEN 'overdue' ELSE 'general' END`,
                'scope',
            )
            .addSelect('COUNT(*)', 'total')
            .addSelect(`SUM(CASE WHEN n."isRead" = false THEN 1 ELSE 0 END)`, 'unread')
            .where('n."receiverId" = :receiverId', { receiverId })
            .andWhere('n.type = :type', { type: NotificationType.SUGGEST })
            .andWhere(`n.meta->>'suggestType' = :st`, { st: EXPENSE_SUGGEST_TYPE })
            .setParameter('ovk', OVERDUE_KIND)
            .groupBy('scope')
            .getRawMany<{ scope: string; total: string; unread: string }>();

        const result = {
            general: { total: 0, unread: 0 },
            overdue: { total: 0, unread: 0 },
        };
        for (const r of rows) {
            const key = r.scope === 'overdue' ? 'overdue' : 'general';
            result[key] = { total: Number(r.total || 0), unread: Number(r.unread || 0) };
        }
        return result;
    }

    /** Gom nhóm thông báo theo nhân viên kinh doanh (phân trang theo nhân viên). */
    async groupedByEmployee(opts: {
        receiverId: number;
        scope?: string;
        tab?: 'unread' | 'read';
        page?: number;
        limit?: number;
    }) {
        const scope = this.normalizeScope(opts.scope);
        const page = opts.page && opts.page > 0 ? opts.page : 1;
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;

        const dataQb = this.applyFilters(this.repo.createQueryBuilder('n'), {
            receiverId: opts.receiverId,
            scope,
            tab: opts.tab,
        })
            .andWhere(`n.meta->>'employeeId' IS NOT NULL`)
            .leftJoin('employee', 'e', `e.id = (n.meta->>'employeeId')::int`)
            .select(`(n.meta->>'employeeId')::int`, 'employeeId')
            .addSelect('e.name', 'employeeName')
            .addSelect('e.phone', 'phone')
            .addSelect('COUNT(*)', 'total')
            .addSelect(`SUM(CASE WHEN n."isRead" = false THEN 1 ELSE 0 END)`, 'unreadCount')
            .addSelect(`MAX(n."createdAt")`, 'latestAt')
            .groupBy(`(n.meta->>'employeeId')::int`)
            .addGroupBy('e.name')
            .addGroupBy('e.phone')
            .orderBy('"latestAt"', 'DESC')
            .addOrderBy('"unreadCount"', 'DESC')
            .offset((page - 1) * limit)
            .limit(limit);

        const rows = await dataQb.getRawMany<{
            employeeId: number;
            employeeName: string | null;
            phone: string | null;
            total: string;
            unreadCount: string;
            latestAt: Date | null;
        }>();

        // Tổng số nhân viên (để phân trang theo nhân viên).
        const countRow = await this.applyFilters(this.repo.createQueryBuilder('n'), {
            receiverId: opts.receiverId,
            scope,
            tab: opts.tab,
        })
            .andWhere(`n.meta->>'employeeId' IS NOT NULL`)
            .select(`COUNT(DISTINCT (n.meta->>'employeeId'))`, 'cnt')
            .getRawOne<{ cnt: string }>();

        const total = Number(countRow?.cnt || 0);

        return {
            scope,
            data: rows.map((r) => ({
                employeeId: r.employeeId,
                employeeName: r.employeeName,
                phone: r.phone,
                total: Number(r.total || 0),
                unreadCount: Number(r.unreadCount || 0),
                latestAt: r.latestAt,
            })),
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    /** Danh sách phẳng (dùng cho tab quá hạn hoặc khi bung 1 nhân viên). */
    async list(opts: {
        receiverId: number;
        scope?: string;
        tab?: 'unread' | 'read';
        employeeId?: number;
        page?: number;
        limit?: number;
    }) {
        const scope = this.normalizeScope(opts.scope);
        const page = opts.page && opts.page > 0 ? opts.page : 1;
        const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;

        const [data, total] = await this.applyFilters(
            this.repo.createQueryBuilder('n'),
            {
                receiverId: opts.receiverId,
                scope,
                tab: opts.tab,
                employeeId: opts.employeeId,
            },
        )
            .orderBy('n."createdAt"', 'DESC')
            .skip((page - 1) * limit)
            .take(limit)
            .getManyAndCount();

        return {
            scope,
            data,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    async markAsRead(id: number, receiverId: number) {
        await this.repo.update({ id, receiverId }, { isRead: true });
        return { success: true };
    }

    /** Đánh dấu đã đọc theo scope (+ tùy chọn 1 nhân viên). */
    async markAllAsRead(opts: {
        receiverId: number;
        scope?: string;
        employeeId?: number;
    }) {
        const scope = this.normalizeScope(opts.scope);

        const qb = this.repo
            .createQueryBuilder()
            .update(Notification)
            .set({ isRead: true })
            .where('"receiverId" = :receiverId', { receiverId: opts.receiverId })
            .andWhere('type = :type', { type: NotificationType.SUGGEST })
            .andWhere(`meta->>'suggestType' = :st`, { st: EXPENSE_SUGGEST_TYPE })
            .andWhere('"isRead" = false');

        if (scope === 'overdue') {
            qb.andWhere(`meta->>'kind' = :ovk`, { ovk: OVERDUE_KIND });
        } else if (scope === 'general') {
            qb.andWhere(`(meta->>'kind' IS DISTINCT FROM :ovk)`, { ovk: OVERDUE_KIND });
        }

        if (opts.employeeId != null) {
            qb.andWhere(`(meta->>'employeeId')::int = :employeeId`, {
                employeeId: opts.employeeId,
            });
        }

        await qb.execute();
        return { success: true };
    }
}
