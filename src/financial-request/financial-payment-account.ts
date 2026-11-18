import {
  FinanceRole,
  PaymentMethod,
  SignatureSlot,
} from './financial-request.constants';

type ApprovalStepIdentity = {
  approverRole?: FinanceRole | null;
  signatureSlot?: SignatureSlot | null;
};

/** Nhận diện theo cấu hình có cấu trúc, không phụ thuộc tên bước tự do. */
export const isControllerApprovalStep = (step: ApprovalStepIdentity) =>
  step.approverRole === FinanceRole.CONTROLLER ||
  step.signatureSlot === SignatureSlot.CONTROLLER;

/** Tiền mặt dùng nhóm 111; chuyển khoản dùng nhóm 112. */
export const paymentAccountGroup = (method: PaymentMethod | null) =>
  method === PaymentMethod.CASH ? '111' : '112';
