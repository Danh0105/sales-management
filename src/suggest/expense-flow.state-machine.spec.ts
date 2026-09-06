import { ConflictException, ForbiddenException } from '@nestjs/common';

import {
  assertExpenseTransition,
  expenseActorForStatus,
} from './expense-flow.state-machine';
import {
  EXPENSE_TERMINAL_STATUSES,
  SuggestStatus,
} from './SuggestStatus.enum';
import { ExpenseAction } from './enums/expense-action.enum';
import { ExpenseRole } from './constants/expense-roles';

const salesOwner = { actorRoles: [ExpenseRole.SALES], isOwner: true };
const salesOther = { actorRoles: [ExpenseRole.SALES], isOwner: false };
const director = { actorRoles: [ExpenseRole.DIRECTOR], isOwner: false };
const debtAccountant = {
  actorRoles: [ExpenseRole.DEBT_ACCOUNTANT],
  isOwner: false,
};
const treasurer = { actorRoles: [ExpenseRole.TREASURER], isOwner: false };
const salesAdmin = { actorRoles: [ExpenseRole.SALES_ADMIN], isOwner: false };

describe('Expense flow state machine (trong Suggest)', () => {
  // ===== Nhánh A — happy path: duyệt → chi → SPENT =====
  // (tạo đề xuất vào thẳng PENDING_APPROVAL, không còn bước DRAFT/submit)
  it('đi hết luồng đã chi: PENDING_APPROVAL → ... → SPENT', () => {
    let status = SuggestStatus.PENDING_APPROVAL;

    status = assertExpenseTransition(ExpenseAction.APPROVE, status, director);
    expect(status).toBe(SuggestStatus.APPROVED);

    status = assertExpenseTransition(
      ExpenseAction.CREATE_PAYMENT_ORDER,
      status,
      debtAccountant,
    );
    expect(status).toBe(SuggestStatus.PAYMENT_ORDERED);

    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_CASH_RELEASED,
      status,
      treasurer,
    );
    expect(status).toBe(SuggestStatus.CASH_RELEASED);

    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_CASH_RECEIVED,
      status,
      salesOwner,
    );
    expect(status).toBe(SuggestStatus.CASH_RECEIVED);

    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_SPENT,
      status,
      salesOwner,
    );
    expect(status).toBe(SuggestStatus.SPENT);
  });

  // ===== Nhánh B — chưa chi → hoàn quỹ =====
  it('đi luồng chưa chi: CASH_RECEIVED → NOT_SPENT → FUND_RETURNED', () => {
    let status = assertExpenseTransition(
      ExpenseAction.CONFIRM_NOT_SPENT,
      SuggestStatus.CASH_RECEIVED,
      salesOwner,
    );
    expect(status).toBe(SuggestStatus.NOT_SPENT);

    status = assertExpenseTransition(
      ExpenseAction.CONFIRM_FUND_RETURNED,
      status,
      treasurer,
    );
    expect(status).toBe(SuggestStatus.FUND_RETURNED);
  });

  // ===== Nhánh từ chối =====
  it('giám đốc từ chối: PENDING_APPROVAL → REJECTED', () => {
    const status = assertExpenseTransition(
      ExpenseAction.REJECT,
      SuggestStatus.PENDING_APPROVAL,
      director,
    );
    expect(status).toBe(SuggestStatus.REJECTED);
  });

  // ===== Sai trạng thái → 409 =====
  it('duyệt lại đề xuất đã duyệt → ConflictException', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE,
        SuggestStatus.APPROVED,
        director,
      ),
    ).toThrow(ConflictException);
  });

  it('lên lệnh chi khi đã có lệnh chi → ConflictException', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CREATE_PAYMENT_ORDER,
        SuggestStatus.PAYMENT_ORDERED,
        debtAccountant,
      ),
    ).toThrow(ConflictException);
  });

  it('kế toán công nợ được lập lại lệnh chi sau khi hoàn quỹ', () => {
    const status = assertExpenseTransition(
      ExpenseAction.CREATE_PAYMENT_ORDER,
      SuggestStatus.FUND_RETURNED,
      debtAccountant,
    );

    expect(status).toBe(SuggestStatus.PAYMENT_ORDERED);
  });

  it('xác nhận đã chi khi chưa nhận tiền → ConflictException', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_SPENT,
        SuggestStatus.CASH_RELEASED,
        salesOwner,
      ),
    ).toThrow(ConflictException);
  });

  it('hoàn quỹ khi không ở NOT_SPENT → ConflictException', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_FUND_RETURNED,
        SuggestStatus.CASH_RECEIVED,
        treasurer,
      ),
    ).toThrow(ConflictException);
  });

  // ===== Sai role → 403 =====
  it('sales không được duyệt', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE,
        SuggestStatus.PENDING_APPROVAL,
        salesOwner,
      ),
    ).toThrow(ForbiddenException);
  });

  it('thuquy không được lên lệnh chi (việc của ketoan_congno)', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CREATE_PAYMENT_ORDER,
        SuggestStatus.APPROVED,
        treasurer,
      ),
    ).toThrow(ForbiddenException);
  });

  it('ketoan_congno không được xác nhận xuất tiền (việc của thuquy)', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CONFIRM_CASH_RELEASED,
        SuggestStatus.PAYMENT_ORDERED,
        debtAccountant,
      ),
    ).toThrow(ForbiddenException);
  });

  // ===== Sales Admin duyệt ngang quyền Giám đốc =====
  it.each([
    [ExpenseAction.APPROVE, SuggestStatus.APPROVED],
    [ExpenseAction.REJECT, SuggestStatus.REJECTED],
  ])('saleadmin %s được như giám đốc', (action, expected) => {
    expect(
      assertExpenseTransition(action, SuggestStatus.PENDING_APPROVAL, salesAdmin),
    ).toBe(expected);
  });

  it('saleadmin vẫn không được tự duyệt đề xuất của chính mình', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE,
        SuggestStatus.PENDING_APPROVAL,
        { actorRoles: [ExpenseRole.SALES_ADMIN], isOwner: true },
      ),
    ).toThrow(ForbiddenException);
  });

  it('saleadmin vừa làm bước liền trước thì không được duyệt tiếp', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.APPROVE,
        SuggestStatus.PENDING_APPROVAL,
        {
          actorRoles: [ExpenseRole.SALES_ADMIN],
          isOwner: false,
          actorId: 9,
          previousActorId: 9,
        },
      ),
    ).toThrow(ForbiddenException);
  });

  it('saleadmin không lấn sang bước của kế toán/thủ quỹ', () => {
    expect(() =>
      assertExpenseTransition(
        ExpenseAction.CREATE_PAYMENT_ORDER,
        SuggestStatus.APPROVED,
        salesAdmin,
      ),
    ).toThrow(ForbiddenException);
  });

  // ===== Ownership — chỉ chính người tạo =====
  it.each([
    [ExpenseAction.CONFIRM_CASH_RECEIVED, SuggestStatus.CASH_RELEASED],
    [ExpenseAction.CONFIRM_SPENT, SuggestStatus.CASH_RECEIVED],
    [ExpenseAction.CONFIRM_NOT_SPENT, SuggestStatus.CASH_RECEIVED],
  ])('sales khác không được %s thay chủ đề xuất', (action, status) => {
    expect(() => assertExpenseTransition(action, status, salesOther)).toThrow(
      ForbiddenException,
    );
  });

  // ===== actor giữ bước (reminder / my-tasks) =====
  it('map đúng actor đang giữ bước theo status', () => {
    expect(expenseActorForStatus(SuggestStatus.PENDING_APPROVAL)).toEqual({
      roles: [ExpenseRole.DIRECTOR, ExpenseRole.SALES_ADMIN],
      owner: false,
    });
    expect(expenseActorForStatus(SuggestStatus.APPROVED)).toEqual({
      roles: [ExpenseRole.DEBT_ACCOUNTANT],
      owner: false,
    });
    expect(expenseActorForStatus(SuggestStatus.PAYMENT_ORDERED)).toEqual({
      roles: [ExpenseRole.TREASURER],
      owner: false,
    });
    expect(expenseActorForStatus(SuggestStatus.NOT_SPENT)).toEqual({
      roles: [ExpenseRole.TREASURER],
      owner: false,
    });
    expect(expenseActorForStatus(SuggestStatus.CASH_RELEASED)).toEqual({
      roles: [ExpenseRole.SALES],
      owner: true,
    });
    expect(expenseActorForStatus(SuggestStatus.DRAFT)).toBeNull();
    expect(expenseActorForStatus(SuggestStatus.SPENT)).toBeNull();
    expect(expenseActorForStatus(SuggestStatus.FUND_RETURNED)).toEqual({
      roles: [ExpenseRole.DEBT_ACCOUNTANT],
      owner: false,
    });
    expect(expenseActorForStatus(SuggestStatus.REJECTED)).toBeNull();
  });
});

describe('phân tách nhiệm vụ khi một người giữ nhiều role', () => {
    // Nhân viên có thật trong hệ thống: vừa `sales` vừa `thuquy`. Nếu chỉ kiểm
    // "có role không", người này tự lên đề xuất rồi tự xuất tiền cho chính mình.
    const salesAndTreasurerOwner = {
        actorRoles: [ExpenseRole.SALES, ExpenseRole.TREASURER],
        isOwner: true,
    };

    it('chủ đề xuất kiêm thủ quỹ KHÔNG được tự xác nhận xuất tiền', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                salesAndTreasurerOwner,
            ),
        ).toThrow(ForbiddenException);
    });

    it('chính thủ quỹ đó vẫn xuất tiền bình thường cho đề xuất của người khác', () => {
        // Kiêm nhiệm không bị tước quyền — chỉ cấm tự làm cho chính mình.
        expect(
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                { ...salesAndTreasurerOwner, isOwner: false },
            ),
        ).toBe(SuggestStatus.CASH_RELEASED);
    });

    it('chủ đề xuất kiêm thủ quỹ KHÔNG được tự xác nhận nhận lại quỹ', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.CONFIRM_FUND_RETURNED,
                SuggestStatus.NOT_SPENT,
                salesAndTreasurerOwner,
            ),
        ).toThrow(ForbiddenException);
    });

    it('chủ đề xuất kiêm kế toán công nợ KHÔNG được tự lên lệnh chi', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.CREATE_PAYMENT_ORDER,
                SuggestStatus.APPROVED,
                {
                    actorRoles: [ExpenseRole.SALES, ExpenseRole.DEBT_ACCOUNTANT],
                    isOwner: true,
                },
            ),
        ).toThrow(ForbiddenException);
    });

    it('chủ đề xuất kiêm giám đốc KHÔNG được tự duyệt', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.APPROVE,
                SuggestStatus.PENDING_APPROVAL,
                {
                    actorRoles: [ExpenseRole.SALES, ExpenseRole.DIRECTOR],
                    isOwner: true,
                },
            ),
        ).toThrow(ForbiddenException);
    });

    it('thông báo lỗi nói rõ vì sao bị chặn và ai mới được làm', () => {
        try {
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                salesAndTreasurerOwner,
            );
            throw new Error('đáng lẽ phải ném lỗi');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain('người tạo đề xuất');
            expect(message).toContain(ExpenseRole.TREASURER);
        }
    });

    it('các bước ownerOnly vẫn giữ nguyên: chủ đề xuất làm được', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RECEIVED,
                SuggestStatus.CASH_RELEASED,
                salesAndTreasurerOwner,
            ),
        ).toBe(SuggestStatus.CASH_RECEIVED);
    });

    it('sai role vẫn báo lỗi role, không bị nuốt bởi luật chủ đề xuất', () => {
        // Người ngoài cuộc, không có role nào phù hợp — lỗi phải nói về role.
        try {
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                { actorRoles: [ExpenseRole.SALES], isOwner: false },
            );
            throw new Error('đáng lẽ phải ném lỗi');
        } catch (error) {
            expect((error as Error).message).toContain('Không có quyền');
        }
    });
});

describe('không cho một người làm hai chốt kiểm soát liên tiếp', () => {
    // Nhân viên có thật: vừa `ketoan_congno` vừa `thuquy`. Lên lệnh chi rồi tự
    // xuất tiền cho chính lệnh đó là một mình đi qua cả hai cửa — kể cả khi đề
    // xuất là của người khác, nên luật "cấm chủ đơn" không bắt được ca này.
    const ACCOUNTANT_TREASURER = 991;
    const dual = {
        actorRoles: [ExpenseRole.DEBT_ACCOUNTANT, ExpenseRole.TREASURER],
        isOwner: false,
        actorId: ACCOUNTANT_TREASURER,
    };

    it('vừa lên lệnh chi thì không được tự xuất tiền tiếp', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                { ...dual, previousActorId: ACCOUNTANT_TREASURER },
            ),
        ).toThrow(ForbiddenException);
    });

    it('người khác lên lệnh chi thì họ xuất tiền bình thường', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                { ...dual, previousActorId: 992 },
            ),
        ).toBe(SuggestStatus.CASH_RELEASED);
    });

    it('chưa có bước nào trước đó thì không chặn', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.APPROVE,
                SuggestStatus.PENDING_APPROVAL,
                {
                    actorRoles: [ExpenseRole.DIRECTOR],
                    isOwner: false,
                    actorId: 5,
                    previousActorId: null,
                },
            ),
        ).toBe(SuggestStatus.APPROVED);
    });

    it('bước của chủ đề xuất được miễn — nhận tiền rồi xác nhận đã chi liền tay', () => {
        // Chủ đơn vốn phải làm mấy bước của mình liên tiếp; áp luật này vào đó
        // sẽ khoá chết luồng bình thường.
        expect(
            assertExpenseTransition(
                ExpenseAction.CONFIRM_SPENT,
                SuggestStatus.CASH_RECEIVED,
                {
                    actorRoles: [ExpenseRole.SALES],
                    isOwner: true,
                    actorId: 7,
                    previousActorId: 7,
                },
            ),
        ).toBe(SuggestStatus.SPENT);
    });

    it('không truyền actorId thì luật này không kích hoạt', () => {
        // Giữ tương thích cho các nơi gọi chưa cấp thông tin người thao tác.
        expect(
            assertExpenseTransition(
                ExpenseAction.CONFIRM_CASH_RELEASED,
                SuggestStatus.PAYMENT_ORDERED,
                { actorRoles: [ExpenseRole.TREASURER], isOwner: false },
            ),
        ).toBe(SuggestStatus.CASH_RELEASED);
    });
});

describe('chủ đề xuất tự rút đơn', () => {
    const owner = {
        actorRoles: [ExpenseRole.SALES],
        isOwner: true,
        actorId: 7,
        previousActorId: 7,
    };

    it('rút được khi còn nháp', () => {
        expect(
            assertExpenseTransition(ExpenseAction.WITHDRAW, SuggestStatus.DRAFT, owner),
        ).toBe(SuggestStatus.WITHDRAWN);
    });

    it('rút được khi đang chờ duyệt', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.PENDING_APPROVAL,
                owner,
            ),
        ).toBe(SuggestStatus.WITHDRAWN);
    });

    it('đã duyệt rồi thì không rút được nữa', () => {
        // Qua bước duyệt là đã có người khác xử lý; muốn dừng phải đi đường khác.
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.APPROVED,
                owner,
            ),
        ).toThrow(ConflictException);
    });

    it('người khác không rút hộ được', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.PENDING_APPROVAL,
                { ...owner, isOwner: false },
            ),
        ).toThrow(ForbiddenException);
    });

    it('WITHDRAWN là trạng thái riêng, không lẫn với REJECTED', () => {
        // Gộp hai thứ này lại thì mọi thống kê tỉ lệ duyệt đều sai.
        expect(SuggestStatus.WITHDRAWN).not.toBe(SuggestStatus.REJECTED);
        expect(EXPENSE_TERMINAL_STATUSES).toContain(SuggestStatus.WITHDRAWN);
    });
});

describe('giám đốc rút hộ đề xuất của người khác (overrideRoles)', () => {
    const directorNotOwner = {
        actorRoles: [ExpenseRole.DIRECTOR],
        isOwner: false,
    };

    it('giám đốc rút được đề xuất không phải của mình', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.PENDING_APPROVAL,
                directorNotOwner,
            ),
        ).toBe(SuggestStatus.WITHDRAWN);
    });

    it('giám đốc rút được cả khi đề xuất còn ở DRAFT', () => {
        expect(
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.DRAFT,
                directorNotOwner,
            ),
        ).toBe(SuggestStatus.WITHDRAWN);
    });

    it('giám đốc không rút được đề xuất đã qua duyệt (vẫn theo đúng `from`)', () => {
        expect(() =>
            assertExpenseTransition(
                ExpenseAction.WITHDRAW,
                SuggestStatus.APPROVED,
                directorNotOwner,
            ),
        ).toThrow(ConflictException);
    });

    it('sales không có overrideRoles nên vẫn không rút hộ được đơn của người khác', () => {
        expect(() =>
            assertExpenseTransition(ExpenseAction.WITHDRAW, SuggestStatus.PENDING_APPROVAL, {
                actorRoles: [ExpenseRole.SALES],
                isOwner: false,
            }),
        ).toThrow(ForbiddenException);
    });

    it('sales là chủ đơn vẫn tự rút bình thường (không cần overrideRoles)', () => {
        expect(
            assertExpenseTransition(ExpenseAction.WITHDRAW, SuggestStatus.PENDING_APPROVAL, {
                actorRoles: [ExpenseRole.SALES],
                isOwner: true,
            }),
        ).toBe(SuggestStatus.WITHDRAWN);
    });
});
