import {
  FinanceRole,
  PaymentMethod,
  SignatureSlot,
} from './financial-request.constants';
import {
  isControllerApprovalStep,
  paymentAccountGroup,
} from './financial-payment-account';

describe('financial payment account', () => {
  it('nhận diện bước kiểm soát bằng vai trò hoặc ô chữ ký', () => {
    expect(
      isControllerApprovalStep({ approverRole: FinanceRole.CONTROLLER }),
    ).toBe(true);
    expect(
      isControllerApprovalStep({ signatureSlot: SignatureSlot.CONTROLLER }),
    ).toBe(true);
    expect(
      isControllerApprovalStep({
        approverRole: FinanceRole.ACCOUNTANT,
        signatureSlot: SignatureSlot.ACCOUNTANT,
      }),
    ).toBe(false);
  });

  it('ánh xạ hình thức thanh toán sang đúng nhóm tài khoản', () => {
    expect(paymentAccountGroup(PaymentMethod.CASH)).toBe('111');
    expect(paymentAccountGroup(PaymentMethod.BANK_TRANSFER)).toBe('112');
  });
});
