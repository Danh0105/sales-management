import { AuthUser } from '../type/auth-user.type';
import { OtherCashflowContract } from './entities/other-cashflow-contract.entity';
import {
  EDITABLE_STATUSES,
  OTHER_CASHFLOW_APPROVE_ROLES,
  OTHER_CASHFLOW_CREATE_ROLES,
  OTHER_CASHFLOW_DEBT_ROLES,
  OTHER_CASHFLOW_RECORD_ROLES,
  OTHER_CASHFLOW_VIEW_ALL_ROLES,
  OtherCashflowForm,
  OtherCashflowStatus,
  RECORDABLE_STATUSES,
} from './other-cashflow.constants';

/**
 * Quyền của phân hệ Thu Chi ngoài — luôn suy ra từ access token, không từ
 * tham số FE. Hàm thuần để kiểm thử riêng.
 */

function rolesOf(user: AuthUser): string[] {
  return user.roles ?? (user.role ? [user.role] : []);
}

function hasAny(user: AuthUser, roles: string[]): boolean {
  return rolesOf(user).some((role) => roles.includes(role));
}

export const canCreate = (user: AuthUser) =>
  hasAny(user, OTHER_CASHFLOW_CREATE_ROLES);

export const canApprove = (user: AuthUser) =>
  hasAny(user, OTHER_CASHFLOW_APPROVE_ROLES);

export const canRecord = (user: AuthUser) =>
  hasAny(user, OTHER_CASHFLOW_RECORD_ROLES);

/** Kế toán công nợ: lập/huỷ phiếu thu, lệnh chi của đơn Thương mại. */
export const canManageDebt = (user: AuthUser) =>
  hasAny(user, OTHER_CASHFLOW_DEBT_ROLES);

export const canViewAll = (user: AuthUser) =>
  hasAny(user, OTHER_CASHFLOW_VIEW_ALL_ROLES);

/** Vào được phân hệ: xem tất cả, hoặc là NV kinh doanh (xem phiếu của mình). */
export const canUseModule = (user: AuthUser) =>
  canViewAll(user) || canCreate(user);

const isOwner = (user: AuthUser, contract: OtherCashflowContract) =>
  contract.createdById === user.id;

export const canView = (user: AuthUser, contract: OtherCashflowContract) =>
  canViewAll(user) || isOwner(user, contract);

export const canEdit = (user: AuthUser, contract: OtherCashflowContract) =>
  isOwner(user, contract) && EDITABLE_STATUSES.includes(contract.status);

export const canReview = (user: AuthUser, contract: OtherCashflowContract) =>
  canApprove(user) && contract.status === OtherCashflowStatus.PENDING;

/**
 * Huỷ: người lập khi còn chờ duyệt / bị từ chối; giám đốc khi đã duyệt mà
 * chưa ghi nhận đồng nào (hợp đồng không thực hiện nữa).
 */
export const canCancel = (user: AuthUser, contract: OtherCashflowContract) =>
  canEdit(user, contract) ||
  (canApprove(user) &&
    contract.status === OtherCashflowStatus.APPROVED &&
    contract.recordedAmount === 0 &&
    contract.paidCostAmount === 0);

const isCommercial = (contract: OtherCashflowContract) =>
  contract.form === OtherCashflowForm.COMMERCIAL;

/** Ghi nhận trực tiếp — chỉ hợp đồng thường; đơn Thương mại thu/chi theo phiếu. */
export const canRecordEntry = (
  user: AuthUser,
  contract: OtherCashflowContract,
) =>
  canRecord(user) &&
  !isCommercial(contract) &&
  RECORDABLE_STATUSES.includes(contract.status);

export const canCreateOrder = (
  user: AuthUser,
  contract: OtherCashflowContract,
) =>
  canManageDebt(user) &&
  isCommercial(contract) &&
  RECORDABLE_STATUSES.includes(contract.status);

/** Thủ quỹ thu/chi theo phiếu đang chờ. */
export const canExecuteOrder = (
  user: AuthUser,
  contract: OtherCashflowContract,
) =>
  canRecord(user) &&
  isCommercial(contract) &&
  contract.status !== OtherCashflowStatus.CANCELLED;

/** Tệp hợp đồng: người lập, khi hợp đồng chưa huỷ/hoàn tất. */
export const canUploadContractFile = (
  user: AuthUser,
  contract: OtherCashflowContract,
) =>
  isOwner(user, contract) &&
  contract.status !== OtherCashflowStatus.CANCELLED &&
  contract.status !== OtherCashflowStatus.COMPLETED;

/** Xoá tệp hợp đồng chỉ trước khi duyệt — sau đó tệp là căn cứ đã duyệt. */
export const canDeleteContractFile = canEdit;

/** Chứng từ thu/chi: thủ quỹ. */
export const canManageEvidence = (user: AuthUser) => canRecord(user);

export function permissionsOf(user: AuthUser, contract: OtherCashflowContract) {
  return {
    canEdit: canEdit(user, contract),
    canReview: canReview(user, contract),
    canCancel: canCancel(user, contract),
    canRecord: canRecordEntry(user, contract),
    canCreateOrder: canCreateOrder(user, contract),
    canCancelOrder: canManageDebt(user) && isCommercial(contract),
    canExecuteOrder: canExecuteOrder(user, contract),
    canVoidEntry: canRecord(user),
    canUploadContract: canUploadContractFile(user, contract),
    canDeleteContractFile: canDeleteContractFile(user, contract),
    canManageEvidence: canManageEvidence(user),
  };
}
