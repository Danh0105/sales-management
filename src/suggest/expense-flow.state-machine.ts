import { ConflictException, ForbiddenException } from '@nestjs/common';

import { SuggestStatus } from './SuggestStatus.enum';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRole } from './constants/expense-roles';
import { ExpenseRequestKind } from './enums/expense-request-kind.enum';

export interface TransitionDef {
  from: SuggestStatus[];
  to: SuggestStatus;
  /** role được phép thực hiện action */
  roles: string[];
  /**
   * `true`  — chỉ chính người tạo đề xuất được thực hiện.
   * `false` (mặc định) — chính người tạo đề xuất **không** được thực hiện.
   *
   * Không có trạng thái thứ ba: mỗi bước trong luồng chi tiền hoặc là việc của
   * người đề xuất, hoặc là một chốt kiểm soát do người khác giữ. Xem
   * `assertExpenseTransition`.
   */
  ownerOnly?: boolean;
  /**
   * Vai trò được miễn hoàn toàn ràng buộc `ownerOnly` ở trên — có role này thì
   * làm được bất kể có phải chủ đơn hay không. Dùng cho quyền giám sát rộng
   * hơn luồng thông thường (VD: Giám đốc rút hộ bất kỳ đề xuất nào, không chỉ
   * đơn của chính mình). Phải là tập con của `roles`.
   */
  overrideRoles?: string[];
  /**
   * Loại đề xuất được phép dùng action này. Bỏ trống = áp cho cả hai loại
   * (các bước dùng chung: tạo, duyệt, từ chối, rút đơn, xác nhận đã dùng /
   * chưa dùng). Cần thiết vì hai nhánh dùng chung một số trạng thái —
   * `APPROVED` là việc của kế toán công nợ với đề xuất tiền nhưng là việc của
   * phòng kỹ thuật với đề xuất thiết bị.
   */
  kinds?: ExpenseRequestKind[];
}

/**
 * State machine cho luồng ĐỀ XUẤT CHI:
 *
 * DRAFT → PENDING_APPROVAL → APPROVED → PAYMENT_ORDERED → CASH_RELEASED
 *       → CASH_RECEIVED → SPENT (kết thúc - đã chi)
 *                        ↘ NOT_SPENT → FUND_RETURNED ─┐
 *                                      ↑             │
 *                                      └─ PAYMENT_ORDERED (lập lại lệnh chi)
 * PENDING_APPROVAL → REJECTED (kết thúc - bị từ chối)
 *
 * Với ĐỀ XUẤT THIẾT BỊ (kind = EQUIPMENT), nhánh sau APPROVED đổi sang phòng
 * kỹ thuật:
 *
 * APPROVED → STOCK_ISSUE_ORDERED → EQUIPMENT_RECEIVED → SPENT
 *                                                     ↘ NOT_SPENT
 *                                                        → EQUIPMENT_RETURNED ─┐
 *                                                           ↑                  │
 *                                                           └─ STOCK_ISSUE_ORDERED
 */
export const EXPENSE_TRANSITIONS: Partial<
  Record<ExpenseAction, TransitionDef>
> = {
  /**
   * Sales Admin duyệt/từ chối **ngang quyền Giám đốc**: cùng một chốt quyết
   * định, ai xử lý trước thì chốt luôn — không phải hai bước nối tiếp. Các
   * ràng buộc phân tách nhiệm vụ vẫn giữ nguyên: không tự duyệt đơn của mình,
   * và không được duyệt nếu chính mình vừa làm bước liền trước (VD đã kiểm
   * duyệt chính sách của đúng đề xuất đó).
   */
  [ExpenseAction.APPROVE]: {
    from: [SuggestStatus.PENDING_APPROVAL],
    to: SuggestStatus.APPROVED,
    roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
  },

  [ExpenseAction.REJECT]: {
    from: [SuggestStatus.PENDING_APPROVAL],
    to: SuggestStatus.REJECTED,
    roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
  },

  /**
   * Chủ đề xuất tự rút đơn khi chưa được duyệt. Giám đốc rút hộ được đơn của
   * BẤT KỲ ai (không cần là chủ đơn) — `overrideRoles` miễn ràng buộc
   * `ownerOnly` riêng cho role này, ví dụ khi chủ đơn nghỉ việc/không tự rút.
   *
   * Có action riêng vì `REJECT` đã cấm chủ đề xuất (phân tách nhiệm vụ), nên
   * không có cách nào tự huỷ đơn của mình. Kết thúc ở `WITHDRAWN` chứ không
   * phải `REJECTED`: tự rút và bị giám đốc từ chối là hai việc khác nhau, gộp
   * lại thì mọi thống kê tỉ lệ duyệt đều sai.
   */
  [ExpenseAction.WITHDRAW]: {
    from: [SuggestStatus.DRAFT, SuggestStatus.PENDING_APPROVAL],
    to: SuggestStatus.WITHDRAWN,
    roles: [ExpenseRole.SALES, ExpenseRole.DIRECTOR],
    ownerOnly: true,
    overrideRoles: [ExpenseRole.DIRECTOR],
  },

  [ExpenseAction.CREATE_PAYMENT_ORDER]: {
    from: [SuggestStatus.APPROVED, SuggestStatus.FUND_RETURNED],
    to: SuggestStatus.PAYMENT_ORDERED,
    roles: [ExpenseRole.DEBT_ACCOUNTANT],
    kinds: [ExpenseRequestKind.CASH],
  },

  [ExpenseAction.CONFIRM_CASH_RELEASED]: {
    from: [SuggestStatus.PAYMENT_ORDERED],
    to: SuggestStatus.CASH_RELEASED,
    roles: [ExpenseRole.TREASURER],
    kinds: [ExpenseRequestKind.CASH],
  },

  [ExpenseAction.CONFIRM_CASH_RECEIVED]: {
    from: [SuggestStatus.CASH_RELEASED],
    to: SuggestStatus.CASH_RECEIVED,
    roles: [ExpenseRole.SALES],
    ownerOnly: true,
    kinds: [ExpenseRequestKind.CASH],
  },

  [ExpenseAction.CONFIRM_SPENT]: {
    from: [SuggestStatus.CASH_RECEIVED, SuggestStatus.EQUIPMENT_RECEIVED],
    to: SuggestStatus.SPENT,
    roles: [ExpenseRole.SALES],
    ownerOnly: true,
  },

  [ExpenseAction.CONFIRM_NOT_SPENT]: {
    from: [SuggestStatus.CASH_RECEIVED, SuggestStatus.EQUIPMENT_RECEIVED],
    to: SuggestStatus.NOT_SPENT,
    roles: [ExpenseRole.SALES],
    ownerOnly: true,
  },

  [ExpenseAction.CONFIRM_FUND_RETURNED]: {
    from: [SuggestStatus.NOT_SPENT],
    to: SuggestStatus.FUND_RETURNED,
    roles: [ExpenseRole.TREASURER],
    kinds: [ExpenseRequestKind.CASH],
  },

  // ===== nhánh ĐỀ XUẤT THIẾT BỊ =====
  // Phòng kỹ thuật giữ cả hai chốt (lên lệnh xuất kho, nhận lại thiết bị) —
  // tương ứng kế toán công nợ + thủ quỹ ở nhánh tiền. Không có bước "xuất
  // kho" tách riêng: lệnh xuất kho được lập là hàng đã sẵn sàng giao, bước
  // kế tiếp là kinh doanh xác nhận đã nhận.

  [ExpenseAction.CREATE_STOCK_ISSUE_ORDER]: {
    from: [SuggestStatus.APPROVED, SuggestStatus.EQUIPMENT_RETURNED],
    to: SuggestStatus.STOCK_ISSUE_ORDERED,
    roles: [ExpenseRole.TECHNICAL],
    kinds: [ExpenseRequestKind.EQUIPMENT],
  },

  [ExpenseAction.CONFIRM_EQUIPMENT_RECEIVED]: {
    from: [SuggestStatus.STOCK_ISSUE_ORDERED],
    to: SuggestStatus.EQUIPMENT_RECEIVED,
    roles: [ExpenseRole.SALES],
    ownerOnly: true,
    kinds: [ExpenseRequestKind.EQUIPMENT],
  },

  [ExpenseAction.CONFIRM_EQUIPMENT_RETURNED]: {
    from: [SuggestStatus.NOT_SPENT],
    to: SuggestStatus.EQUIPMENT_RETURNED,
    roles: [ExpenseRole.TECHNICAL],
    kinds: [ExpenseRequestKind.EQUIPMENT],
  },
};

export interface TransitionContext {
  actorRoles: string[];
  /** Loại đề xuất; mặc định `CASH` để giữ nguyên hành vi của luồng tiền. */
  kind?: ExpenseRequestKind;
  isOwner: boolean;
  /** id người đang thao tác — để so với người làm bước ngay trước. */
  actorId?: number | null;
  /**
   * Người thực hiện bước gần nhất trên **cùng đề xuất** (`null` khi chưa có
   * bước nào). Dùng để chặn một người làm hai chốt kiểm soát liên tiếp.
   */
  previousActorId?: number | null;
}

/**
 * Kiểm tra + trả về status mới.
 * - Sai role / không phải chủ đề xuất → 403
 * - Chủ đề xuất tự làm bước kiểm soát của người khác → 403 (phân tách nhiệm vụ)
 * - Sai trạng thái hiện tại → 409 (chống double-submit / idempotency)
 *
 * **Phân tách nhiệm vụ.** Role trong hệ thống là mảng, nên một người có thể vừa
 * là `sales` vừa là `thuquy`. Nếu chỉ hỏi "có role không", người đó tự lên đề
 * xuất rồi tự xuất tiền cho chính mình: hai chốt kiểm soát đáng lẽ do hai người
 * giữ sụp vào một người. Vì vậy mọi bước **không** phải `ownerOnly` đều cấm
 * chính người tạo đề xuất — kiêm nhiệm vẫn được, tự duyệt cho mình thì không.
 */
export function assertExpenseTransition(
  action: ExpenseAction,
  currentStatus: SuggestStatus,
  ctx: TransitionContext,
): SuggestStatus {
  const def = EXPENSE_TRANSITIONS[action];

  if (!def) {
    throw new ConflictException(
      `Action ${action} không phải là một bước chuyển trạng thái`,
    );
  }

  const kind = ctx.kind ?? ExpenseRequestKind.CASH;

  if (def.kinds && !def.kinds.includes(kind)) {
    throw new ConflictException(
      `Action ${action} không thuộc luồng của loại đề xuất ${kind}`,
    );
  }

  if (!ctx.actorRoles?.some((r) => def.roles.includes(r))) {
    throw new ForbiddenException(
      `Không có quyền thực hiện ${action} (yêu cầu role: ${def.roles.join(', ')})`,
    );
  }

  const hasOverrideRole = ctx.actorRoles?.some((r) =>
    def.overrideRoles?.includes(r),
  );

  if (!hasOverrideRole) {
    if (def.ownerOnly && !ctx.isOwner) {
      throw new ForbiddenException(
        'Chỉ chính người tạo đề xuất được thực hiện thao tác này',
      );
    }

    if (!def.ownerOnly && ctx.isOwner) {
      throw new ForbiddenException(
        `Bạn là người tạo đề xuất này nên không được tự thực hiện bước ${action}. ` +
          `Bước này phải do người khác có role ${def.roles.join(', ')} thực hiện.`,
      );
    }
  }

  // Hai chốt kiểm soát liên tiếp phải do hai người khác nhau. Người vừa
  // `ketoan_congno` vừa `thuquy` lên lệnh chi rồi tự xuất tiền cho chính lệnh
  // đó là một mình đi qua cả hai cửa — kể cả khi đề xuất là của người khác.
  // Các bước `ownerOnly` được miễn: chủ đề xuất vốn phải làm liền mấy bước
  // của mình (nhận tiền → xác nhận đã chi).
  if (
    !def.ownerOnly &&
    ctx.actorId != null &&
    ctx.previousActorId != null &&
    ctx.actorId === ctx.previousActorId
  ) {
    throw new ForbiddenException(
      `Bạn vừa thực hiện bước liền trước của đề xuất này nên không được làm tiếp bước ${action}. ` +
        `Hai bước kiểm soát liên tiếp phải do hai người khác nhau.`,
    );
  }

  if (!def.from.includes(currentStatus)) {
    throw new ConflictException(
      `Không thể ${action} khi đề xuất đang ở trạng thái ${currentStatus} ` +
        `(yêu cầu: ${def.from.join(', ')})`,
    );
  }

  return def.to;
}

/**
 * Actor đang "giữ" bước hiện tại — dùng cho reminder & my-tasks.
 * owner = true nghĩa là chính người tạo đề xuất.
 */
export function expenseActorForStatus(
  status: SuggestStatus,
  kind: ExpenseRequestKind = ExpenseRequestKind.CASH,
): { roles: string[]; owner: boolean } | null {
  const isEquipment = kind === ExpenseRequestKind.EQUIPMENT;

  switch (status) {
    case SuggestStatus.CASH_RELEASED:
    case SuggestStatus.CASH_RECEIVED:
    case SuggestStatus.STOCK_ISSUE_ORDERED:
    case SuggestStatus.EQUIPMENT_RECEIVED:
      return { roles: [ExpenseRole.SALES], owner: true };

    // Cả Giám đốc lẫn Sales Admin đều duyệt được bước này nên nhắc cả hai.
    case SuggestStatus.PENDING_APPROVAL:
      return {
        roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
        owner: false,
      };

    // Sau khi duyệt, đề xuất tiền về kế toán công nợ còn đề xuất thiết bị về
    // phòng kỹ thuật — cùng trạng thái nhưng khác người giữ bước.
    case SuggestStatus.APPROVED:
      return {
        roles: [
          isEquipment ? ExpenseRole.TECHNICAL : ExpenseRole.DEBT_ACCOUNTANT,
        ],
        owner: false,
      };

    case SuggestStatus.FUND_RETURNED:
      return { roles: [ExpenseRole.DEBT_ACCOUNTANT], owner: false };

    case SuggestStatus.EQUIPMENT_RETURNED:
      return { roles: [ExpenseRole.TECHNICAL], owner: false };

    // `NOT_SPENT`: tiền thì hoàn về thủ quỹ, thiết bị thì nhập lại kho.
    case SuggestStatus.NOT_SPENT:
      return {
        roles: [isEquipment ? ExpenseRole.TECHNICAL : ExpenseRole.TREASURER],
        owner: false,
      };

    case SuggestStatus.PAYMENT_ORDERED:
      return { roles: [ExpenseRole.TREASURER], owner: false };

    default:
      // SPENT / REJECTED — kết thúc
      return null;
  }
}
