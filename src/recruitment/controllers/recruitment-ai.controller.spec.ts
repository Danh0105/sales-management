import { ForbiddenException } from '@nestjs/common';

import type { RecruitmentAiRequestContext } from '../ai/recruitment-ai-subject';
import {
  ConversationChannel,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { RecruitmentAiController } from './recruitment-ai.controller';

const SUBJECT = { channel: 'zalo' as const, oaId: 'oa1', userId: 'u1' };
const CHANNEL: RecruitmentAiRequestContext = {
  credential: 'channel',
  subject: SUBJECT,
};
const PHASE2: RecruitmentAiRequestContext = { credential: 'ai', subject: null };

function setup() {
  // Mỗi tên hàm một mock cố định, để test kiểm đúng mock mà controller đã gọi.
  const svc = () => {
    const fns: Record<string | symbol, jest.Mock> = {};
    return new Proxy(
      {},
      {
        get: (_t, name) =>
          (fns[name] ??= jest.fn().mockResolvedValue({ ok: true })),
      },
    );
  };
  const candidates: any = svc();
  const conversations: any = svc();
  const ownership = {
    assertCandidate: jest.fn().mockResolvedValue(undefined),
    assertApplication: jest.fn().mockResolvedValue(undefined),
    assertConversation: jest.fn().mockResolvedValue(undefined),
    assertInterview: jest.fn().mockResolvedValue(undefined),
    denyIdentityClaim: jest
      .fn()
      .mockRejectedValue(new ForbiddenException({ code: 'SUBJECT_MISMATCH' })),
  };
  const controller = new RecruitmentAiController(
    svc() as any, // jobs
    candidates,
    svc() as any, // applications
    conversations,
    svc() as any, // screening
    svc() as any, // interviews
    svc() as any, // handoffs
    svc() as any, // privacy
    ownership as any,
  );
  return { controller, ownership, candidates, conversations };
}

const message = {
  candidateId: 7,
  applicationId: 12,
  channel: ConversationChannel.WEB,
  externalConversationId: 'model-khai-bua',
  externalMessageId: 'm-1',
  senderType: MessageSenderType.CANDIDATE,
  direction: MessageDirection.INBOUND,
  content: 'xin chào',
};

describe('RecruitmentAiController — kiểm ownership theo subject', () => {
  it('mọi thao tác theo id đều kiểm đúng loại tài nguyên và đúng id', async () => {
    const { controller, ownership } = setup();
    await controller.getCandidate(7, CHANNEL);
    await controller.updateCandidate(7, {} as any, CHANNEL);
    await controller.requestDeletion(7, {} as any, CHANNEL);
    await controller.findOrCreateApplication(
      { candidateId: 7, jobId: 1 } as any,
      CHANNEL,
    );
    await controller.getApplicationContext(12, CHANNEL);
    await controller.screenCandidate(12, {} as any, CHANNEL);
    await controller.handoffToHr(12, {} as any, CHANNEL);
    await controller.getConversationContext(3, CHANNEL);
    await controller.proposeInterview(
      { applicationId: 12, slotId: 4 } as any,
      CHANNEL,
    );
    await controller.confirmInterview(9, CHANNEL);

    expect(ownership.assertCandidate.mock.calls).toEqual([
      [SUBJECT, 7, 'getCandidate'],
      [SUBJECT, 7, 'updateCandidate'],
      [SUBJECT, 7, 'requestCandidateDeletion'],
      [SUBJECT, 7, 'findOrCreateApplication'],
    ]);
    expect(ownership.assertApplication.mock.calls).toEqual([
      [SUBJECT, 12, 'getApplicationContext'],
      [SUBJECT, 12, 'screenCandidate'],
      [SUBJECT, 12, 'handoffToHR'],
      [SUBJECT, 12, 'proposeInterview'],
    ]);
    expect(ownership.assertConversation).toHaveBeenCalledWith(
      SUBJECT,
      3,
      'getConversationContext',
    );
    expect(ownership.assertInterview).toHaveBeenCalledWith(
      SUBJECT,
      9,
      'confirmInterview',
    );
  });

  it('lưu tin nhắn: kiểm cả candidateId lẫn applicationId; kênh và hội thoại theo subject', async () => {
    const { controller, ownership, conversations } = setup();
    await controller.saveCandidateMessage({ ...message }, CHANNEL);

    expect(ownership.assertCandidate).toHaveBeenCalledWith(
      SUBJECT,
      7,
      'saveMessage',
    );
    expect(ownership.assertApplication).toHaveBeenCalledWith(
      SUBJECT,
      12,
      'saveMessage',
    );
    expect(conversations.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: ConversationChannel.ZALO,
        externalConversationId: 'u1',
      }),
    );
  });

  it('ownership từ chối → không gọi service', async () => {
    const { controller, ownership, candidates } = setup();
    ownership.assertCandidate.mockRejectedValueOnce(
      new ForbiddenException({ code: 'SUBJECT_MISMATCH' }),
    );
    await expect(
      controller.updateCandidate(5, { phone: '0900000000' } as any, CHANNEL),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(candidates.aiUpdate).not.toHaveBeenCalled();
  });

  it('tìm/tạo ứng viên: danh tính lấy từ subject; model khai zaloUserId khác → chặn', async () => {
    const { controller, ownership, candidates } = setup();
    await controller.findOrCreateCandidate({ fullName: 'A' } as any, CHANNEL);
    expect(candidates.aiFindOrCreate).toHaveBeenCalledWith(
      { fullName: 'A' },
      SUBJECT,
    );

    await expect(
      controller.findOrCreateCandidate(
        { zaloUserId: 'victim' } as any,
        CHANNEL,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ownership.denyIdentityClaim).toHaveBeenCalledWith(
      SUBJECT,
      'findOrCreateCandidate',
    );
    expect(candidates.aiFindOrCreate).toHaveBeenCalledTimes(1);
  });

  it('chế độ Phase 2 (không subject) → không kiểm ownership, giữ nguyên payload', async () => {
    const { controller, ownership, conversations } = setup();
    await controller.getCandidate(7, PHASE2);
    await controller.saveCandidateMessage({ ...message }, PHASE2);
    expect(ownership.assertCandidate).not.toHaveBeenCalled();
    expect(conversations.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: ConversationChannel.WEB,
        externalConversationId: 'model-khai-bua',
      }),
    );
  });
});
