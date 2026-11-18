import {
  ApproverType,
  SelfApprovalMode,
  StepStatus,
} from './financial-request.constants';
import {
  nextStepsAfterDecision,
  pickWorkflow,
  planSteps,
  WorkflowPlanError,
} from './financial-workflow';

const wf = (
  id: number,
  companyId: number | null,
  requestType: string | null,
  isActive = true,
) => ({
  id,
  companyId,
  requestType,
  isActive,
});

describe('pickWorkflow — chọn quy trình cụ thể nhất', () => {
  const all = [
    wf(1, null, null),
    wf(2, null, 'ADVANCE'),
    wf(3, 7, null),
    wf(4, 7, 'ADVANCE'),
    wf(5, 7, 'SETTLEMENT', false),
  ];
  it('công ty + loại thắng', () =>
    expect(pickWorkflow(all, 7, 'ADVANCE')?.id).toBe(4));
  it('công ty khi không có loại riêng', () =>
    expect(pickWorkflow(all, 7, 'EXPENSE_PAYMENT')?.id).toBe(3));
  it('bỏ qua quy trình đã tắt', () =>
    expect(pickWorkflow(all, 7, 'SETTLEMENT')?.id).toBe(3));
  it('loại chung khi công ty khác', () =>
    expect(pickWorkflow(all, 9, 'ADVANCE')?.id).toBe(2));
  it('mặc định chung', () =>
    expect(pickWorkflow(all, 9, 'SALARY_ADVANCE')?.id).toBe(1));
  it('không có gì thì null', () =>
    expect(pickWorkflow([wf(1, 3, null)], 9, 'ADVANCE')).toBeNull());
});

const defs = [
  {
    stepOrder: 1,
    name: 'Quản lý trực tiếp',
    approverType: ApproverType.DIRECT_MANAGER,
    minAmount: null,
  },
  {
    stepOrder: 2,
    name: 'Kiểm soát',
    approverType: ApproverType.ROLE,
    minAmount: null,
  },
  {
    stepOrder: 3,
    name: 'Kế toán',
    approverType: ApproverType.ROLE,
    minAmount: null,
  },
  {
    stepOrder: 4,
    name: 'BGĐ',
    approverType: ApproverType.ROLE,
    minAmount: 20_000_000,
  },
];
const resolved = (entries: [number, number[], boolean?][]) =>
  new Map(
    entries.map(([order, candidates, was]) => [
      order,
      { candidates, requesterWasCandidate: !!was },
    ]),
  );

describe('planSteps — dựng vòng duyệt', () => {
  it('tuần tự: chỉ bước đầu PENDING; dưới hạn mức thì bỏ cấp BGĐ', () => {
    const plan = planSteps(
      defs,
      5_000_000,
      SelfApprovalMode.BLOCK,
      true,
      resolved([
        [1, [10]],
        [2, [11]],
        [3, [12]],
        [4, [13]],
      ]),
    );
    expect(plan.map((p) => p.status)).toEqual([
      StepStatus.PENDING,
      StepStatus.WAITING,
      StepStatus.WAITING,
      StepStatus.SKIPPED,
    ]);
  });

  it('trên hạn mức thì cấp BGĐ bắt buộc', () => {
    const plan = planSteps(
      defs,
      25_000_000,
      SelfApprovalMode.BLOCK,
      true,
      resolved([
        [1, [10]],
        [2, [11]],
        [3, [12]],
        [4, [13]],
      ]),
    );
    expect(plan[3].status).toBe(StepStatus.WAITING);
  });

  it('song song: mọi bước áp dụng đều PENDING', () => {
    const plan = planSteps(
      defs,
      25_000_000,
      SelfApprovalMode.BLOCK,
      false,
      resolved([
        [1, [10]],
        [2, [11]],
        [3, [12]],
        [4, [13]],
      ]),
    );
    expect(plan.every((p) => p.status === StepStatus.PENDING)).toBe(true);
  });

  it('BLOCK: cấp không có người duyệt → không cho gửi (không âm thầm bỏ qua)', () => {
    expect(() =>
      planSteps(
        defs,
        5_000_000,
        SelfApprovalMode.BLOCK,
        true,
        resolved([
          [1, [10]],
          [2, []],
          [3, [12]],
        ]),
      ),
    ).toThrow(WorkflowPlanError);
  });

  it('BLOCK: chưa chọn quản lý trực tiếp → báo đúng lỗi', () => {
    expect(() =>
      planSteps(
        defs,
        5_000_000,
        SelfApprovalMode.BLOCK,
        true,
        resolved([
          [1, []],
          [2, [11]],
          [3, [12]],
        ]),
      ),
    ).toThrow(/quản lý trực tiếp/);
  });

  it('SKIP_STEP: người đề nghị là người duyệt duy nhất → bỏ qua cấp đó', () => {
    const plan = planSteps(
      defs,
      5_000_000,
      SelfApprovalMode.SKIP_STEP,
      true,
      resolved([
        [1, [10]],
        [2, [], true],
        [3, [12]],
      ]),
    );
    expect(plan[1].status).toBe(StepStatus.SKIPPED);
    expect(plan[0].status).toBe(StepStatus.PENDING);
  });

  it('SKIP_STEP vẫn báo lỗi nếu cấp trống không phải do người đề nghị', () => {
    expect(() =>
      planSteps(
        defs,
        5_000_000,
        SelfApprovalMode.SKIP_STEP,
        true,
        resolved([
          [1, [10]],
          [2, [], false],
          [3, [12]],
        ]),
      ),
    ).toThrow(WorkflowPlanError);
  });
});

describe('nextStepsAfterDecision', () => {
  const s = (stepOrder: number, status: StepStatus) => ({ stepOrder, status });
  it('mở bước WAITING kế tiếp khi tuần tự', () => {
    const steps = [
      s(1, StepStatus.APPROVED),
      s(2, StepStatus.WAITING),
      s(3, StepStatus.WAITING),
    ];
    expect(nextStepsAfterDecision(steps, true)).toEqual({
      toActivate: [steps[1]],
      finished: false,
    });
  });
  it('xong vòng khi không còn bước mở', () => {
    expect(
      nextStepsAfterDecision(
        [s(1, StepStatus.APPROVED), s(2, StepStatus.SKIPPED)],
        true,
      ),
    ).toEqual({ toActivate: [], finished: true });
  });
  it('song song: còn bước PENDING thì chờ', () => {
    expect(
      nextStepsAfterDecision(
        [s(1, StepStatus.APPROVED), s(2, StepStatus.PENDING)],
        false,
      ),
    ).toEqual({ toActivate: [], finished: false });
  });
});
