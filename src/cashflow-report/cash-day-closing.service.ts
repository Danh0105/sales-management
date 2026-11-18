import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { addDays, vnToday } from '../financial-request/financial-calculations';
import { AuthUser } from '../type/auth-user.type';
import { isCronLeader } from '../utils/is-cron-leader';
import {
  CashDayClosing,
  DayClosingBalance,
  DayClosingMode,
} from './cash-day-closing.entity';
import { centsToString, toCents } from './cashflow-money';
import { CashflowReportService } from './cashflow-report.service';
import { snapshotDay, vnDate } from './day-closing';

type Queryable = Pick<EntityManager, 'query'>;

/** Khoá mọi giao dịch chốt/mở lại để bấm End of Day và cron 0h không chốt trùng. */
const CLOSING_LOCK_KEY = 1795200000;
/** Chốt bù tối đa bấy nhiêu ngày một lần (chặn vòng lặp vô tận khi dữ liệu lạ). */
const MAX_GAP_DAYS = 400;
const AUTO_NAME = 'Tự động (sau 0h)';

/** Ngày chốt quỹ gần nhất: mọi ngày ≤ ngày này bị khoá trên Tổng hợp thu chi. */
export async function cashLockedThrough(db: Queryable): Promise<string | null> {
  const [row] = await db.query<{ date: string | null }[]>(
    `SELECT to_char(max(closing_date), 'YYYY-MM-DD') AS date FROM cash_day_closings WHERE status = 'CLOSED'`,
  );
  return row?.date ?? null;
}

export function lockedMessage(date: string, lockedThrough: string): string {
  return `Ngày ${vnDate(date)} đã chốt quỹ (chốt đến ${vnDate(lockedThrough)}) — nhờ kế toán trưởng / giám đốc mở lại ngày chốt nếu cần sửa.`;
}

/** Chặn thao tác trên Tổng hợp thu chi với ngày đã chốt. */
export async function assertCashDayOpen(db: Queryable, ...dates: string[]) {
  const locked = await cashLockedThrough(db);
  if (!locked) return;
  const closed = dates.filter((date) => date <= locked).sort()[0];
  if (closed) throw new BadRequestException(lockedMessage(closed, locked));
}

/** Chốt quỹ ngày (End of Day), tự chốt sau 0h, mở lại ngày chốt gần nhất. */
@Injectable()
export class CashDayClosingService {
  private readonly logger = new Logger(CashDayClosingService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly report: CashflowReportService,
  ) {}

  async status() {
    const today = vnToday();
    const lockedThrough = await cashLockedThrough(this.dataSource);
    const latest = lockedThrough
      ? await this.dataSource.getRepository(CashDayClosing).findOne({
          where: { closingDate: lockedThrough, status: 'CLOSED' },
        })
      : null;
    return {
      today,
      lockedThrough,
      todayClosed: !!lockedThrough && lockedThrough >= today,
      latest: latest ? this.view(latest) : null,
    };
  }

  /** Lịch sử chốt (cả lần đã mở lại) trong khoảng ngày. */
  async list(from: string, to: string) {
    const rows = await this.dataSource
      .getRepository(CashDayClosing)
      .createQueryBuilder('c')
      .where('c.closing_date BETWEEN :from AND :to', { from, to })
      .orderBy('c.closing_date', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .getMany();
    return rows.map((row) => this.view(row));
  }

  /** Xem trước các ngày sẽ chốt và số dư từng tài khoản, chưa ghi gì. */
  async preview(date?: string) {
    const target = this.targetDate(date);
    const lockedThrough = await cashLockedThrough(this.dataSource);
    const days = this.daysToClose(target, lockedThrough);
    const accounts = await this.report.loadAccounts();
    const { lines } = await this.report.collect(accounts);
    return {
      lockedThrough,
      days: days.map((day) => ({
        date: day,
        balances: snapshotDay(accounts, lines, day),
      })),
    };
  }

  /**
   * Chốt ngày `date` (mặc định hôm nay) và mọi ngày chưa chốt trước đó kể từ
   * ngày chốt gần nhất. `user = null` là cron tự chốt.
   */
  async close(
    user: AuthUser | null,
    date?: string,
    mode: DayClosingMode = 'MANUAL',
  ) {
    const target = this.targetDate(date);
    const actorName = user ? await this.actorName(user) : AUTO_NAME;
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        CLOSING_LOCK_KEY,
      ]);
      const lockedThrough = await cashLockedThrough(manager);
      const days = this.daysToClose(target, lockedThrough);
      const accounts = await this.report.loadAccounts();
      const { lines } = await this.report.collect(accounts);
      const repo = manager.getRepository(CashDayClosing);
      const closed: CashDayClosing[] = [];
      for (const day of days) {
        const balances = snapshotDay(accounts, lines, day);
        closed.push(
          await repo.save(
            repo.create({
              closingDate: day,
              status: 'CLOSED',
              mode,
              balances,
              lineCount: balances.reduce((sum, b) => sum + b.lineCount, 0),
              closedBy: user?.id ?? null,
              closedByName: actorName,
            }),
          ),
        );
      }
      return {
        lockedThrough: target,
        closed: closed.map((row) => this.view(row)),
      };
    });
  }

  /** Mở lại ngày chốt gần nhất (kế toán trưởng / giám đốc), bắt buộc lý do. */
  async reopen(user: AuthUser, reason: string) {
    const text = reason?.trim();
    if (!text) throw new BadRequestException('Nhập lý do mở lại ngày chốt');
    const actorName = await this.actorName(user);
    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1)', [
        CLOSING_LOCK_KEY,
      ]);
      const lockedThrough = await cashLockedThrough(manager);
      if (!lockedThrough) {
        throw new NotFoundException('Chưa có ngày nào được chốt quỹ');
      }
      const repo = manager.getRepository(CashDayClosing);
      const row = await repo.findOneOrFail({
        where: { closingDate: lockedThrough, status: 'CLOSED' },
      });
      row.status = 'REOPENED';
      row.reopenedBy = user.id;
      row.reopenedByName = actorName;
      row.reopenedAt = new Date();
      row.reopenReason = text;
      await repo.save(row);
      return {
        reopened: this.view(row),
        lockedThrough: await cashLockedThrough(manager),
      };
    });
  }

  /** 00:05 giờ VN: tự chốt các ngày chưa chốt tới hết hôm qua (chỉ instance production). */
  @Cron('5 0 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async autoClose() {
    if (!isCronLeader()) return;
    try {
      const yesterday = addDays(vnToday(), -1);
      const lockedThrough = await cashLockedThrough(this.dataSource);
      if (lockedThrough && lockedThrough >= yesterday) return;
      const result = await this.close(null, yesterday, 'AUTO');
      this.logger.log(
        `Tự chốt quỹ ${result.closed.map((c) => c.date).join(', ')}`,
      );
    } catch (error) {
      this.logger.error(
        `Tự chốt quỹ lỗi: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  private targetDate(date?: string): string {
    const today = vnToday();
    const target = date ?? today;
    if (target > today) {
      throw new BadRequestException('Không chốt quỹ ngày trong tương lai');
    }
    return target;
  }

  private daysToClose(target: string, lockedThrough: string | null): string[] {
    if (lockedThrough && target <= lockedThrough) {
      throw new BadRequestException(
        `Ngày ${vnDate(target)} đã chốt quỹ (chốt đến ${vnDate(lockedThrough)})`,
      );
    }
    // Lần chốt đầu tiên chỉ chốt đúng ngày đó; sau đó chốt liền mạch, không bỏ ngày.
    const days: string[] = [];
    for (
      let day = lockedThrough ? addDays(lockedThrough, 1) : target;
      day <= target;
      day = addDays(day, 1)
    ) {
      days.push(day);
      if (days.length > MAX_GAP_DAYS) {
        throw new BadRequestException(
          `Còn hơn ${MAX_GAP_DAYS} ngày chưa chốt — liên hệ quản trị`,
        );
      }
    }
    return days;
  }

  private view(row: CashDayClosing) {
    const sum = (pick: (b: DayClosingBalance) => string | null) =>
      row.balances.some((b) => pick(b) === null)
        ? null
        : centsToString(
            row.balances.reduce((total, b) => total + toCents(pick(b)), 0n),
          );
    return {
      id: row.id,
      date: row.closingDate,
      status: row.status,
      mode: row.mode,
      closedByName: row.closedByName,
      closedAt: row.closedAt,
      reopenedByName: row.reopenedByName,
      reopenedAt: row.reopenedAt,
      reopenReason: row.reopenReason,
      lineCount: row.lineCount,
      totals: {
        receipts: sum((b) => b.receipts),
        payments: sum((b) => b.payments),
        closing: sum((b) => b.closing),
      },
      balances: row.balances,
    };
  }

  /** Token có thể thiếu tên — lấy từ hồ sơ nhân viên. */
  private async actorName(user: AuthUser): Promise<string | null> {
    if (user.name) return user.name;
    const [row] = await this.dataSource.query<{ name: string }[]>(
      'SELECT name FROM employee WHERE id = $1',
      [user.id],
    );
    return row?.name ?? null;
  }
}
