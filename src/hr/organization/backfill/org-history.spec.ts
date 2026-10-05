import {
  canonicalJson,
  ExistingOrgState,
  OrgBackfillPlan,
  planHash,
  validateBackfill,
} from './org-history';

const TODAY = '2026-10-01';

/** Cơ cấu tạo qua UI hôm nay: công ty + chi nhánh CM + phòng KD, bắt đầu 2026-10-01. */
function existing(): ExistingOrgState {
  return {
    unitIds: new Map([
      ['CTY', 1],
      ['CN-CM', 2],
      ['KD', 3],
    ]),
    revisions: [
      {
        unitCode: 'CTY',
        unitType: 'COMPANY',
        name: 'Công ty',
        parentCode: null,
        status: 'ACTIVE',
        effectiveFrom: TODAY,
        effectiveTo: null,
      },
      {
        unitCode: 'CN-CM',
        unitType: 'BRANCH',
        name: 'Chi nhánh Cà Mau',
        parentCode: 'CTY',
        status: 'ACTIVE',
        effectiveFrom: TODAY,
        effectiveTo: null,
      },
      {
        unitCode: 'KD',
        unitType: 'DEPARTMENT',
        name: 'Phòng Kinh doanh',
        parentCode: 'CN-CM',
        status: 'ACTIVE',
        effectiveFrom: TODAY,
        effectiveTo: null,
      },
    ],
    leaders: [],
    employees: new Map([
      ['NV000001', { id: 11, status: 'ACTIVE', name: 'A' }],
      ['NV000002', { id: 12, status: 'ACTIVE', name: 'B' }],
      ['NV000003', { id: 13, status: 'INACTIVE', name: 'C (đã nghỉ)' }],
    ]),
    positions: new Map([['GD', { id: 1, isActive: true }]]),
  };
}

/** Lịch sử thật: công ty từ 2020, chi nhánh từ 2021, phòng KD từ 2022 (tên cũ). */
const historyPlan: OrgBackfillPlan = {
  history: [
    {
      code: 'CTY',
      revisions: [
        { effectiveFrom: '2020-01-01', unitType: 'COMPANY', name: 'Công ty' },
      ],
    },
    {
      code: 'CN-CM',
      revisions: [
        {
          effectiveFrom: '2021-03-01',
          unitType: 'BRANCH',
          name: 'Chi nhánh Cà Mau',
          parentCode: 'CTY',
        },
      ],
    },
    {
      code: 'KD',
      revisions: [
        {
          effectiveFrom: '2022-01-01',
          unitType: 'DEPARTMENT',
          name: 'Phòng Bán hàng',
          parentCode: 'CN-CM',
        },
        {
          effectiveFrom: '2024-07-01',
          unitType: 'DEPARTMENT',
          name: 'Phòng Kinh doanh',
          parentCode: 'CN-CM',
        },
      ],
    },
  ],
};

describe('validateBackfill — lịch sử hợp lệ', () => {
  it('chèn lịch sử trước revision hiện có: nối liền, không chồng, kiểm tra mọi mốc', () => {
    const r = validateBackfill(historyPlan, existing(), TODAY);
    expect(r.errors).toEqual([]);
    const kd = r.revisions.filter((x) => x.unitCode === 'KD');
    expect(kd.map((x) => [x.effectiveFrom, x.effectiveTo])).toEqual([
      ['2022-01-01', '2024-06-30'],
      ['2024-07-01', '2026-09-30'],
    ]);
    expect(r.revisions.every((x) => x.source === 'PREPEND')).toBe(true);
    expect(r.checkpoints).toBeGreaterThanOrEqual(5);
  });

  it('đơn vị mới hoàn toàn + lãnh đạo lịch sử (người đã nghỉ, vai trò đã kết thúc)', () => {
    const r = validateBackfill(
      {
        ...historyPlan,
        units: [
          {
            ref: 'cn_la',
            revisions: [
              {
                effectiveFrom: '2023-01-01',
                unitType: 'BRANCH',
                name: 'Chi nhánh Long An',
                parentCode: 'CTY',
              },
              {
                effectiveFrom: '2025-12-31',
                unitType: 'BRANCH',
                name: 'Chi nhánh Long An',
                parentCode: 'CTY',
                status: 'INACTIVE',
              },
            ],
          },
        ],
        leaders: [
          {
            unitRef: 'cn_la',
            employeeCode: 'NV000003',
            leaderRole: 'BRANCH_DIRECTOR',
            isApprovalAuthority: true,
            effectiveFrom: '2023-01-01',
            effectiveTo: '2025-12-30',
            positionCode: 'GD',
          },
          {
            unitCode: 'CN-CM',
            employeeCode: 'NV000001',
            leaderRole: 'BRANCH_DIRECTOR',
            isApprovalAuthority: true,
            effectiveFrom: '2021-03-01',
          },
        ],
      },
      existing(),
      TODAY,
    );
    expect(r.errors).toEqual([]);
    expect(r.newUnitRefs).toEqual(['cn_la']);
    expect(r.leaders).toHaveLength(2);
  });
});

describe('validateBackfill — từ chối', () => {
  const errorsOf = (plan: OrgBackfillPlan, state = existing()) =>
    validateBackfill(plan, state, TODAY).errors.join('\n');

  it('ngày tương lai → từ chối (tương lai dùng API thường)', () => {
    expect(
      errorsOf({
        units: [
          {
            ref: 'xx',
            revisions: [
              {
                effectiveFrom: '2026-10-02',
                unitType: 'DEPARTMENT',
                name: 'x',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      }),
    ).toContain('chỉ cho ngày đến hôm nay');
  });

  it('đơn vị mới tự chọn mã ("code") → từ chối (mã do hệ thống sinh)', () => {
    expect(
      errorsOf({
        units: [
          {
            code: 'KD',
            revisions: [
              {
                effectiveFrom: '2022-01-01',
                unitType: 'DEPARTMENT',
                name: 'x',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      } as unknown as OrgBackfillPlan),
    ).toContain('không được tự chọn mã');
  });

  it('lịch sử chèn thêm chồng lên revision hiện có → từ chối', () => {
    expect(
      errorsOf({
        history: [
          {
            code: 'KD',
            revisions: [
              {
                effectiveFrom: TODAY,
                unitType: 'DEPARTMENT',
                name: 'x',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      }),
    ).toContain('phải bắt đầu trước revision đầu tiên');
  });

  it('revision không tăng dần → từ chối', () => {
    expect(
      errorsOf({
        units: [
          {
            ref: 'xx',
            revisions: [
              {
                effectiveFrom: '2023-01-01',
                unitType: 'DEPARTMENT',
                name: 'x',
                parentCode: 'CN-CM',
              },
              {
                effectiveFrom: '2022-01-01',
                unitType: 'DEPARTMENT',
                name: 'y',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      }),
    ).toContain('tăng dần');
  });

  it('đơn vị tồn tại trước khi cha tồn tại (ở mốc quá khứ) → từ chối', () => {
    expect(
      errorsOf({
        units: [
          {
            ref: 'xx',
            revisions: [
              {
                effectiveFrom: '2020-06-01',
                unitType: 'DEPARTMENT',
                name: 'x',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      }),
    ).toContain('HR_ORG_PARENT_NOT_FOUND');
  });

  it('công ty thứ hai trong quá khứ → từ chối', () => {
    expect(
      errorsOf({
        ...historyPlan,
        units: [
          {
            ref: 'cty2',
            revisions: [
              {
                effectiveFrom: '2021-01-01',
                unitType: 'COMPANY',
                name: 'Công ty 2',
              },
            ],
          },
        ],
      }),
    ).toContain('HR_ORG_COMPANY_EXISTS');
  });

  it('vòng lặp ở mốc quá khứ → từ chối', () => {
    expect(
      errorsOf({
        units: [
          {
            ref: 'aa',
            revisions: [
              {
                effectiveFrom: '2026-09-01',
                unitType: 'DEPARTMENT',
                name: 'A',
                parentRef: 'bb',
              },
            ],
          },
          {
            ref: 'bb',
            revisions: [
              {
                effectiveFrom: '2026-09-01',
                unitType: 'DEPARTMENT',
                name: 'B',
                parentRef: 'aa',
              },
            ],
          },
        ],
      }),
    ).toContain('Vòng tham chiếu parentRef');
  });

  it('hai người duyệt chính chồng thời gian → từ chối', () => {
    const e = errorsOf({
      ...historyPlan,
      leaders: [
        {
          unitCode: 'CN-CM',
          employeeCode: 'NV000001',
          leaderRole: 'BRANCH_DIRECTOR',
          isApprovalAuthority: true,
          effectiveFrom: '2021-03-01',
          effectiveTo: '2023-12-31',
        },
        {
          unitCode: 'CN-CM',
          employeeCode: 'NV000002',
          leaderRole: 'BRANCH_DIRECTOR',
          isApprovalAuthority: true,
          effectiveFrom: '2023-06-01',
        },
      ],
    });
    expect(e).toContain('hai người duyệt chính');
  });

  it('lãnh đạo trước khi đơn vị tồn tại / sai loại đơn vị → từ chối', () => {
    expect(
      errorsOf({
        leaders: [
          {
            unitCode: 'CN-CM',
            employeeCode: 'NV000001',
            leaderRole: 'BRANCH_DIRECTOR',
            isApprovalAuthority: true,
            effectiveFrom: '2025-01-01',
            effectiveTo: '2025-02-01',
          },
        ],
      }),
    ).toContain('HR_ORG_UNIT_INACTIVE');
    expect(
      errorsOf({
        ...historyPlan,
        leaders: [
          {
            unitCode: 'KD',
            employeeCode: 'NV000001',
            leaderRole: 'BRANCH_DIRECTOR',
            isApprovalAuthority: false,
            effectiveFrom: '2023-01-01',
            effectiveTo: '2023-02-01',
          },
        ],
      }),
    ).toContain('HR_ORG_LEADER_ROLE');
  });

  it('người đã nghỉ giữ vai trò tới hôm nay → từ chối; nhân viên không tồn tại → từ chối', () => {
    expect(
      errorsOf({
        ...historyPlan,
        leaders: [
          {
            unitCode: 'KD',
            employeeCode: 'NV000003',
            leaderRole: 'DEPARTMENT_HEAD',
            isApprovalAuthority: true,
            effectiveFrom: '2023-01-01',
          },
        ],
      }),
    ).toContain('không còn hoạt động');
    expect(
      errorsOf({
        leaders: [
          {
            unitCode: 'KD',
            employeeCode: 'NV999999',
            leaderRole: 'DEPARTMENT_HEAD',
            isApprovalAuthority: true,
            effectiveFrom: TODAY,
          },
        ],
      }),
    ).toContain('không có hồ sơ');
  });

  it('đóng đơn vị khi còn đơn vị con hoạt động (quá khứ) → từ chối', () => {
    expect(
      errorsOf({
        history: [
          {
            code: 'CTY',
            revisions: [
              {
                effectiveFrom: '2020-01-01',
                unitType: 'COMPANY',
                name: 'Công ty',
              },
            ],
          },
          {
            code: 'CN-CM',
            revisions: [
              {
                effectiveFrom: '2021-03-01',
                unitType: 'BRANCH',
                name: 'Chi nhánh Cà Mau',
                parentCode: 'CTY',
              },
              {
                effectiveFrom: '2023-01-01',
                unitType: 'BRANCH',
                name: 'Chi nhánh Cà Mau',
                parentCode: 'CTY',
                status: 'INACTIVE',
              },
            ],
          },
          {
            code: 'KD',
            revisions: [
              {
                effectiveFrom: '2022-01-01',
                unitType: 'DEPARTMENT',
                name: 'KD',
                parentCode: 'CN-CM',
              },
            ],
          },
        ],
      }),
    ).toMatch(/HR_ORG_HAS_ACTIVE_CHILDREN|HR_ORG_PARENT_INACTIVE/);
  });
});

describe('validateBackfill — ref tạm và mã hệ thống sinh', () => {
  const dept = (
    name: string,
    parent: { parentRef?: string; parentCode?: string },
    effectiveFrom = '2024-01-01',
  ) => ({ effectiveFrom, unitType: 'DEPARTMENT' as const, name, ...parent });
  /** Cơ cấu có sẵn từ 2020 để đơn vị mới năm 2024 có cha. */
  const since2020 = (): ExistingOrgState => ({
    ...existing(),
    revisions: existing().revisions.map((x) => ({
      ...x,
      effectiveFrom: '2020-01-01',
    })),
  });

  it('thứ tự phụ thuộc: cha trước con, hoà theo thứ tự khai — luôn như nhau', () => {
    const plan: OrgBackfillPlan = {
      units: [
        {
          ref: 'team_con',
          revisions: [dept('Tổ con', { parentRef: 'phong_moi' })],
        },
        {
          ref: 'phong_khac',
          revisions: [dept('Phòng khác', { parentCode: 'CN-CM' })],
        },
        {
          ref: 'phong_moi',
          revisions: [dept('Phòng mới', { parentCode: 'CN-CM' })],
        },
      ],
    };
    const a = validateBackfill(plan, since2020(), TODAY);
    const b = validateBackfill(plan, since2020(), TODAY);
    expect(a.errors).toEqual([]);
    expect(a.newUnitRefs).toEqual(['phong_khac', 'phong_moi', 'team_con']);
    expect(b.newUnitRefs).toEqual(a.newUnitRefs);
    expect(
      a.revisions.find((r) => r.unitCode === 'ref:team_con')?.parentCode,
    ).toBe('ref:phong_moi');
  });

  it('ref trùng / ref sai định dạng / parentRef không có trong kế hoạch → từ chối', () => {
    const e = validateBackfill(
      {
        units: [
          { ref: 'phong_a', revisions: [dept('A', { parentCode: 'CN-CM' })] },
          { ref: 'phong_a', revisions: [dept('A2', { parentCode: 'CN-CM' })] },
          { ref: 'Phong-B', revisions: [dept('B', { parentCode: 'CN-CM' })] },
          { ref: 'phong_c', revisions: [dept('C', { parentRef: 'khong_co' })] },
        ],
      },
      since2020(),
      TODAY,
    ).errors.join('\n');
    expect(e).toContain('ref "phong_a": khai trùng');
    expect(e).toContain('ref "Phong-B" không hợp lệ');
    expect(e).toContain('parentRef "khong_co" không có trong phần "units"');
  });

  it('khai cả parentCode và parentRef → từ chối; cha là mã không tồn tại → từ chối', () => {
    const e = validateBackfill(
      {
        units: [
          {
            ref: 'phong_a',
            revisions: [
              dept('A', { parentCode: 'CN-CM', parentRef: 'phong_b' }),
            ],
          },
          { ref: 'phong_b', revisions: [dept('B', { parentCode: 'DV9999' })] },
        ],
      },
      since2020(),
      TODAY,
    ).errors.join('\n');
    expect(e).toContain('chỉ khai một trong parentCode / parentRef');
    expect(e).toContain('đơn vị cha "DV9999" không tồn tại');
  });

  it('tự tham chiếu chính mình → vòng tham chiếu', () => {
    expect(
      validateBackfill(
        {
          units: [
            {
              ref: 'phong_a',
              revisions: [dept('A', { parentRef: 'phong_a' })],
            },
          ],
        },
        since2020(),
        TODAY,
      ).errors.join('\n'),
    ).toContain('Vòng tham chiếu parentRef');
  });

  it('ref đã tạo ở lần backfill trước → từ chối, chỉ ra mã đã cấp', () => {
    const state = since2020();
    state.appliedRefs = new Map([['phong_a', { code: 'DV0004', runId: 2 }]]);
    const e = validateBackfill(
      {
        units: [
          { ref: 'phong_a', revisions: [dept('A', { parentCode: 'CN-CM' })] },
        ],
      },
      state,
      TODAY,
    ).errors.join('\n');
    expect(e).toContain('lần backfill #2 thành DV0004');
  });

  it('history phải tham chiếu mã thật; lãnh đạo khai đúng một trong unitCode/unitRef', () => {
    const e = validateBackfill(
      {
        units: [
          { ref: 'phong_a', revisions: [dept('A', { parentCode: 'CN-CM' })] },
        ],
        history: [
          {
            code: 'phong_a',
            revisions: [dept('A', { parentCode: 'CN-CM' }, '2019-01-01')],
          },
        ],
        leaders: [
          {
            unitCode: 'KD',
            unitRef: 'phong_a',
            employeeCode: 'NV000001',
            leaderRole: 'DEPARTMENT_HEAD',
            isApprovalAuthority: true,
            effectiveFrom: '2024-01-01',
          },
          {
            unitRef: 'khong_co',
            employeeCode: 'NV000002',
            leaderRole: 'DEPARTMENT_HEAD',
            isApprovalAuthority: false,
            effectiveFrom: '2024-01-01',
          },
        ],
      },
      since2020(),
      TODAY,
    ).errors.join('\n');
    expect(e).toContain('phần "history" chỉ dành cho đơn vị đã có');
    expect(e).toContain('khai đúng một trong unitCode / unitRef');
    expect(e).toContain('unitRef không có trong phần "units"');
  });

  it('lãnh đạo gắn đơn vị mới qua unitRef → hợp lệ', () => {
    const r = validateBackfill(
      {
        units: [
          { ref: 'phong_a', revisions: [dept('A', { parentCode: 'CN-CM' })] },
        ],
        leaders: [
          {
            unitRef: 'phong_a',
            employeeCode: 'NV000001',
            leaderRole: 'DEPARTMENT_HEAD',
            isApprovalAuthority: true,
            effectiveFrom: '2024-01-01',
          },
        ],
      },
      since2020(),
      TODAY,
    );
    expect(r.errors).toEqual([]);
    expect(r.leaders[0].unitCode).toBe('ref:phong_a');
  });
});

describe('planHash — khoá idempotency', () => {
  it('không phụ thuộc thứ tự khoá / khoảng trắng; khác nội dung → khác hash', () => {
    const a = { units: [{ ref: 'x1', revisions: [] }], leaders: [] };
    const b = JSON.parse(
      '{ "leaders": [],   "units": [ { "revisions": [], "ref": "x1" } ] }',
    ) as OrgBackfillPlan;
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(planHash(a as OrgBackfillPlan)).toBe(planHash(b));
    expect(planHash(a as OrgBackfillPlan)).toMatch(/^[0-9a-f]{64}$/);
    expect(planHash({ units: [{ ref: 'x2', revisions: [] }] })).not.toBe(
      planHash(a as OrgBackfillPlan),
    );
  });
});
