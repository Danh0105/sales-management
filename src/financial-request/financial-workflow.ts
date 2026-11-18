import {
  ApproverType,
  SelfApprovalMode,
  StepStatus,
} from './financial-request.constants';

/**
 * Phần thuần của quy trình duyệt (không đụng DB) — chọn quy trình, dựng các
 * bước cho một vòng duyệt, và tìm bước kế tiếp. Tách riêng để kiểm thử.
 */

export interface WorkflowCandidate {
  id: number;
  companyId: number | null;
  requestType: string | null;
  isActive: boolean;
}

/** Quy trình cụ thể nhất: công ty+loại > công ty > loại > mặc định chung. */
export function pickWorkflow<T extends WorkflowCandidate>(
  workflows: T[],
  companyId: number,
  requestType: string,
): T | null {
  const active = workflows.filter((w) => w.isActive);
  const rank = (w: T) => {
    if (w.companyId !== null && w.companyId !== companyId) return -1;
    if (w.requestType !== null && w.requestType !== requestType) return -1;
    return (w.companyId !== null ? 2 : 0) + (w.requestType !== null ? 1 : 0);
  };
  return (
    active
      .map((w) => ({ w, score: rank(w) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.w.id - b.w.id)[0]?.w ?? null
  );
}

export interface StepDefinition {
  stepOrder: number;
  name: string;
  approverType: ApproverType;
  minAmount: number | null;
}

export interface PlannedStep<T extends StepDefinition> {
  definition: T;
  status: StepStatus;
  candidates: number[];
  comment: string | null;
}

export class WorkflowPlanError extends Error {}

/**
 * Dựng các bước của một vòng duyệt.
 * - Dưới ngưỡng `minAmount` → bỏ qua (hạn mức).
 * - Không còn người duyệt hợp lệ: SKIP_STEP thì bỏ qua nếu chính người đề
 *   nghị là người duyệt; còn lại báo lỗi (không âm thầm bỏ qua cấp kiểm soát).
 * - Tuần tự: bước đầu tiên chưa bỏ qua là PENDING, còn lại WAITING.
 */
export function planSteps<T extends StepDefinition>(
  definitions: T[],
  totalAmount: number,
  selfMode: SelfApprovalMode,
  isSequential: boolean,
  resolved: Map<
    number,
    { candidates: number[]; requesterWasCandidate: boolean }
  >,
): PlannedStep<T>[] {
  const ordered = [...definitions].sort((a, b) => a.stepOrder - b.stepOrder);
  const planned = ordered.map<PlannedStep<T>>((definition) => {
    if (definition.minAmount !== null && totalAmount < definition.minAmount) {
      return {
        definition,
        status: StepStatus.SKIPPED,
        candidates: [],
        comment: 'Dưới hạn mức áp dụng của cấp này',
      };
    }
    const resolution = resolved.get(definition.stepOrder) ?? {
      candidates: [],
      requesterWasCandidate: false,
    };
    if (!resolution.candidates.length) {
      if (
        selfMode === SelfApprovalMode.SKIP_STEP &&
        resolution.requesterWasCandidate
      ) {
        return {
          definition,
          status: StepStatus.SKIPPED,
          candidates: [],
          comment:
            'Người đề nghị là người duyệt của cấp này — bỏ qua theo chính sách',
        };
      }
      throw new WorkflowPlanError(
        definition.approverType === ApproverType.DIRECT_MANAGER
          ? `Cấp "${definition.name}": chưa chọn quản lý trực tiếp hợp lệ`
          : `Cấp "${definition.name}" chưa có người duyệt hợp lệ — liên hệ quản trị phân hệ để phân quyền`,
      );
    }
    return {
      definition,
      status: StepStatus.WAITING,
      candidates: resolution.candidates,
      comment: null,
    };
  });

  const open = planned.filter((p) => p.status === StepStatus.WAITING);
  if (isSequential) {
    if (open[0]) open[0].status = StepStatus.PENDING;
  } else {
    open.forEach((p) => (p.status = StepStatus.PENDING));
  }
  return planned;
}

/** Sau khi một bước xong: bước nào cần mở tiếp (tuần tự), và vòng đã xong chưa. */
export function nextStepsAfterDecision<
  T extends { stepOrder: number; status: StepStatus },
>(steps: T[], isSequential: boolean): { toActivate: T[]; finished: boolean } {
  const remaining = steps
    .filter(
      (s) => s.status === StepStatus.WAITING || s.status === StepStatus.PENDING,
    )
    .sort((a, b) => a.stepOrder - b.stepOrder);
  if (!remaining.length) return { toActivate: [], finished: true };
  if (!isSequential) return { toActivate: [], finished: false };
  const hasPending = remaining.some((s) => s.status === StepStatus.PENDING);
  return { toActivate: hasPending ? [] : [remaining[0]], finished: false };
}
