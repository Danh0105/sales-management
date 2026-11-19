import { BadRequestException } from '@nestjs/common';

import {
  INVOICE_CASH_ACCOUNT_CODES,
  cashAccountLabel,
} from '../revenue-item/invoice-cash-account';

/**
 * Thủ quỹ xuất tiền từ nhiều nguồn chi cho một đề xuất (19/11/2026): mỗi nguồn
 * (tài khoản Nguồn thu chi) một số tiền, tổng = đúng số lệnh chi.
 * - Ghi Đã chi về QL thu chi: các khoản lấy LẦN LƯỢT từ nguồn 1, hết thì sang
 *   nguồn 2… (mỗi dòng ghi riêng từng nguồn + số tiền).
 * - Chi một phần: phần dư trả về các nguồn SAU CÙNG (trừ ngược từ nguồn cuối).
 */
export interface CashSplit {
  cashAccount: string;
  amount: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const MAX_SPLITS = 10;

export const cashSplitsLabel = (splits: CashSplit[]) =>
  splits.map((split) => cashAccountLabel(split.cashAccount)).join(' + ');

/**
 * Chuẩn hoá nguồn chi Thủ quỹ gửi. Client cũ chỉ gửi một `cashAccount` → một
 * nguồn bằng cả lệnh chi. Nhiều nguồn: tài khoản hợp lệ, không trùng, số tiền
 * > 0, tổng = đúng số lệnh chi.
 */
export function normalizeCashSplits(
  input: unknown,
  orderAmount: number,
  singleAccount?: string | null,
): CashSplit[] {
  const total = round2(Number(orderAmount) || 0);
  const list = Array.isArray(input) ? input : [];
  if (!list.length) {
    return singleAccount ? [{ cashAccount: singleAccount, amount: total }] : [];
  }
  if (list.length > MAX_SPLITS) {
    throw new BadRequestException(`Tối đa ${MAX_SPLITS} nguồn chi`);
  }
  const seen = new Set<string>();
  const splits = list.map((raw: any, index) => {
    const cashAccount = String(raw?.cashAccount ?? '').trim();
    if (!(INVOICE_CASH_ACCOUNT_CODES as readonly string[]).includes(cashAccount)) {
      throw new BadRequestException(`Nguồn chi thứ ${index + 1} không hợp lệ`);
    }
    if (seen.has(cashAccount)) {
      throw new BadRequestException(`Nguồn chi ${cashAccount} bị chọn trùng`);
    }
    seen.add(cashAccount);
    const amount = Number(raw?.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) {
      throw new BadRequestException(`Nhập số tiền cho nguồn chi ${cashAccount}`);
    }
    if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) {
      throw new BadRequestException('Số tiền nguồn chi tối đa 2 chữ số thập phân');
    }
    return { cashAccount, amount: round2(amount) };
  });
  const sum = round2(splits.reduce((acc, split) => acc + split.amount, 0));
  if (Math.abs(sum - total) > 0.005) {
    throw new BadRequestException(
      `Tổng số tiền các nguồn chi (${sum.toLocaleString('vi-VN')} đ) phải bằng đúng lệnh chi ` +
        `(${total.toLocaleString('vi-VN')} đ)`,
    );
  }
  return splits;
}

/** Nguồn chi của lệnh chi đã xuất; bản cũ chỉ có một tài khoản = cả lệnh chi. */
export function orderCashSplits(order: {
  cashSplits?: CashSplit[] | null;
  cashAccount?: string | null;
  amount?: number | string | null;
} | null | undefined): CashSplit[] {
  if (!order) return [];
  if (Array.isArray(order.cashSplits) && order.cashSplits.length) {
    return order.cashSplits.map((split) => ({
      cashAccount: split.cashAccount,
      amount: round2(Number(split.amount) || 0),
    }));
  }
  return order.cashAccount
    ? [{ cashAccount: order.cashAccount, amount: round2(Number(order.amount) || 0) }]
    : [];
}

/**
 * Lấy tiền lần lượt từ các nguồn: mỗi lần `take(amount)` trả các phần (tài
 * khoản + số tiền) theo thứ tự nguồn. Hết tiền các nguồn mà vẫn còn (bảng
 * lệch) thì phần thừa tính vào nguồn cuối; không có nguồn thì tài khoản null.
 */
export function createCashSplitCursor(splits: CashSplit[]) {
  const left = splits.map((split) => ({ ...split, amount: round2(split.amount) }));
  let index = 0;
  return {
    take(amount: number): { cashAccount: string | null; amount: number }[] {
      let need = round2(Math.max(0, Number(amount) || 0));
      const parts: { cashAccount: string | null; amount: number }[] = [];
      if (!(need > 0)) return parts;
      if (!left.length) return [{ cashAccount: null, amount: need }];
      while (need > 0 && index < left.length) {
        const current = left[index];
        const share = round2(Math.min(current.amount, need));
        if (share > 0) {
          parts.push({ cashAccount: current.cashAccount, amount: share });
          current.amount = round2(current.amount - share);
          need = round2(need - share);
        }
        if (current.amount <= 0) index += 1;
      }
      if (need > 0) {
        const last = left[left.length - 1].cashAccount;
        const tail = parts[parts.length - 1];
        if (tail && tail.cashAccount === last) tail.amount = round2(tail.amount + need);
        else parts.push({ cashAccount: last, amount: need });
      }
      return parts;
    },
  };
}

/** Phần dư trả về quỹ: trừ ngược từ nguồn cuối lên. */
export function returnCashSplits(splits: CashSplit[], returnAmount: number): CashSplit[] {
  let left = round2(Math.max(0, Number(returnAmount) || 0));
  const result: CashSplit[] = [];
  for (let i = splits.length - 1; i >= 0 && left > 0; i -= 1) {
    const share = round2(Math.min(splits[i].amount, left));
    if (share <= 0) continue;
    result.unshift({ cashAccount: splits[i].cashAccount, amount: share });
    left = round2(left - share);
  }
  if (left > 0 && splits.length) {
    const first = result[0];
    if (first && first.cashAccount === splits[0].cashAccount) first.amount = round2(first.amount + left);
    else result.unshift({ cashAccount: splits[0].cashAccount, amount: left });
  }
  return result;
}
