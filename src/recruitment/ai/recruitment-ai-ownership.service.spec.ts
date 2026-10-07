import { ForbiddenException, Logger } from '@nestjs/common';

import { RecruitmentAiOwnershipService } from './recruitment-ai-ownership.service';
import type { RecruitmentAiSubject } from './recruitment-ai-subject';

const ME: RecruitmentAiSubject = { channel: 'zalo', oaId: 'oa1', userId: 'u1' };
const mine = { oaId: 'oa1', userId: 'u1' };
const otherUser = { oaId: 'oa1', userId: 'u2' };
const otherOa = { oaId: 'oa2', userId: 'u1' };

function repo(raw: unknown) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(raw),
  };
  return { createQueryBuilder: jest.fn().mockReturnValue(qb), qb };
}

function setup(raw: {
  candidate?: unknown;
  application?: unknown;
  conversation?: unknown;
  interview?: unknown;
}) {
  const candidates = repo(raw.candidate);
  const applications = repo(raw.application);
  const conversations = repo(raw.conversation);
  const interviews = repo(raw.interview);
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RecruitmentAiOwnershipService(
    candidates as any,
    applications as any,
    conversations as any,
    interviews as any,
    audit as any,
  );
  return {
    service,
    audit,
    candidates,
    applications,
    conversations,
    interviews,
  };
}

async function denied(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForbiddenException);
  const body = (error as ForbiddenException).getResponse() as Record<
    string,
    unknown
  >;
  expect(body.code).toBe('SUBJECT_MISMATCH');
  // Không trả dữ liệu của bản ghi kia.
  expect(Object.keys(body).sort()).toEqual(['code', 'message']);
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('RecruitmentAiOwnershipService', () => {
  it('ứng viên của chính người gửi → cho qua, không audit', async () => {
    const { service, audit } = setup({ candidate: mine });
    await expect(
      service.assertCandidate(ME, 7, 'getCandidate'),
    ).resolves.toBeUndefined();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    ['người khác cùng OA', otherUser],
    ['cùng user id nhưng OA khác', otherOa],
    ['không tồn tại', undefined],
  ])('ứng viên %s → SUBJECT_MISMATCH + audit DENIED', async (_label, owner) => {
    const { service, audit } = setup({ candidate: owner });
    await denied(service.assertCandidate(ME, 5, 'updateCandidate'));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'AI_SUBJECT_DENIED',
        entity: 'candidates',
        entityId: 5,
        success: false,
        context: {
          subject: 'zalo:oa1:u1',
          operation: 'updateCandidate',
          resourceType: 'candidates',
          resourceId: 5,
          result: 'DENIED',
        },
      }),
    );
    // Audit tối giản: không có payload/tin nhắn.
    const call = audit.record.mock.calls[0][0];
    expect(call.before).toBeUndefined();
    expect(call.after).toBeUndefined();
  });

  it('hồ sơ ứng tuyển: kiểm qua ứng viên sở hữu (join DB)', async () => {
    const ok = setup({ application: mine });
    await expect(
      ok.service.assertApplication(ME, 12, 'screenCandidate'),
    ).resolves.toBeUndefined();
    expect(ok.applications.qb.innerJoin).toHaveBeenCalled();

    const bad = setup({ application: otherUser });
    await denied(bad.service.assertApplication(ME, 12, 'screenCandidate'));
    expect(bad.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'applications', entityId: 12 }),
    );
  });

  it('hội thoại: chủ hội thoại khớp nhưng hồ sơ ứng tuyển gắn kèm của người khác → chặn', async () => {
    const own = setup({
      conversation: {
        ...mine,
        applicationId: null,
        appOaId: null,
        appUserId: null,
      },
    });
    await expect(
      own.service.assertConversation(ME, 3, 'getConversationContext'),
    ).resolves.toBeUndefined();

    const mixed = setup({
      conversation: {
        ...mine,
        applicationId: 40,
        appOaId: 'oa1',
        appUserId: 'u2',
      },
    });
    await denied(
      mixed.service.assertConversation(ME, 3, 'getConversationContext'),
    );
  });

  it('lịch phỏng vấn: hồ sơ ứng tuyển của người khác → chặn dù ứng viên trên lịch khớp', async () => {
    const own = setup({
      interview: { ...mine, ivOaId: 'oa1', ivUserId: 'u1' },
    });
    await expect(
      own.service.assertInterview(ME, 9, 'confirmInterview'),
    ).resolves.toBeUndefined();

    const viaOtherApplication = setup({
      interview: { ...otherUser, ivOaId: 'oa1', ivUserId: 'u1' },
    });
    await denied(
      viaOtherApplication.service.assertInterview(ME, 9, 'confirmInterview'),
    );

    const inconsistent = setup({
      interview: { ...mine, ivOaId: 'oa1', ivUserId: 'u2' },
    });
    await denied(
      inconsistent.service.assertInterview(ME, 9, 'confirmInterview'),
    );
  });

  it('khai danh tính khác subject → SUBJECT_MISMATCH', async () => {
    const { service, audit } = setup({});
    await denied(service.denyIdentityClaim(ME, 'findOrCreateCandidate'));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          operation: 'findOrCreateCandidate',
        }),
      }),
    );
  });

  it('audit lỗi vẫn chặn (fail-closed)', async () => {
    const { service, audit } = setup({ candidate: otherUser });
    audit.record.mockRejectedValueOnce(new Error('db down'));
    await denied(service.assertCandidate(ME, 5, 'getCandidate'));
  });
});
