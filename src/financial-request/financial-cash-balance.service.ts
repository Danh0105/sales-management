import { BadRequestException, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { CashflowReportService } from '../cashflow-report/cashflow-report.service';
import type { CashflowQueryDto } from '../cashflow-report/dto/cashflow-query.dto';
import { vnToday } from './financial-calculations';
import { formatVnd } from './financial-money';

export interface CashBalanceRow {
  code: string;
  name: string;
  groupCode: string;
  isActive: boolean;
  /** Số dư cuối ngày `asOf` theo Tổng hợp thu chi; null = chưa nhập số dư đầu kỳ. */
  balance: number | null;
}

/**
 * Số dư tài khoản tiền theo đúng cách "Tổng hợp thu chi" tính (số dư đầu kỳ đã
 * đối chiếu + mọi phát sinh tới hết ngày `asOf`) — dùng cho phiếu Điều chuyển
 * tiền nội bộ (20/11/2026): số tiền chuyển không vượt số dư nguồn chuyển.
 */
@Injectable()
export class FinancialCashBalanceService {
  constructor(private readonly cashflow: CashflowReportService) {}

  async balances(asOf = vnToday()): Promise<{ asOf: string; accounts: CashBalanceRow[] }> {
    const dataset = await this.cashflow.buildDataset({ from: asOf, to: asOf } as CashflowQueryDto);
    return {
      asOf,
      accounts: dataset.accounts.map((account) => {
        const closing = dataset.balances.get(account.code)?.closing ?? null;
        return {
          code: account.code,
          name: account.name,
          groupCode: account.groupCode,
          isActive: account.isActive,
          balance: closing === null ? null : Number(closing) / 100,
        };
      }),
    };
  }

  /**
   * Chặn khi số tiền vượt số dư nguồn chuyển (hoặc nguồn chưa có số dư đầu kỳ ở
   * Tổng hợp thu chi). `manager` có thì khoá theo tài khoản trong transaction để
   * hai lần ghi nhận cùng lúc không cùng lọt qua.
   */
  async assertCovers(
    code: string,
    amount: number,
    asOf = vnToday(),
    manager?: EntityManager,
  ) {
    if (manager) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `cash-balance:${code}`,
      ]);
    }
    const { accounts } = await this.balances(asOf);
    const account = accounts.find((row) => row.code === code);
    if (!account) {
      throw new BadRequestException(`Tài khoản tiền "${code}" không có trong Tổng hợp thu chi`);
    }
    if (account.balance === null) {
      throw new BadRequestException(
        `Tài khoản ${code} - ${account.name} chưa nhập số dư đầu kỳ ở Tổng hợp thu chi nên chưa biết số dư — nhập số dư đầu kỳ trước khi điều chuyển`,
      );
    }
    if (amount > account.balance + 0.005) {
      throw new BadRequestException(
        `Số tiền điều chuyển ${formatVnd(amount)} đ vượt số dư của ${code} - ${account.name} (${formatVnd(account.balance)} đ, theo Tổng hợp thu chi đến ${asOf.split('-').reverse().join('/')})`,
      );
    }
  }
}
