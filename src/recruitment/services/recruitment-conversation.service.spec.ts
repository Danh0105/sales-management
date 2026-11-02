import {
  ConversationChannel,
  ConversationStatus,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { RecruitmentConversationService } from './recruitment-conversation.service';

function setup() {
  const conversation = {
    id: 4,
    candidateId: 7,
    applicationId: null,
    channel: ConversationChannel.ZALO,
    externalConversationId: 'zc-1',
    status: ConversationStatus.ACTIVE,
    lastMessageAt: null,
  };
  const conversationRepo = {
    findOne: jest.fn().mockResolvedValue(conversation),
    findOneOrFail: jest.fn().mockResolvedValue(conversation),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 4, ...v })),
  } as any;
  const messageRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: 900, createdAt: new Date(), ...v })),
  } as any;
  const candidateRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 7 }),
  } as any;
  const applicationRepo = { findOne: jest.fn() } as any;
  const jobRepo = { findOne: jest.fn() } as any;
  const applications = { buildContext: jest.fn() } as any;

  const service = new RecruitmentConversationService(
    conversationRepo,
    messageRepo,
    candidateRepo,
    applicationRepo,
    jobRepo,
    applications,
  );
  return { service, conversationRepo, messageRepo, applicationRepo };
}

const inbound = {
  candidateId: 7,
  channel: ConversationChannel.ZALO,
  externalConversationId: 'zc-1',
  externalMessageId: 'msg-1',
  senderType: MessageSenderType.CANDIDATE,
  direction: MessageDirection.INBOUND,
  content: 'Em muốn ứng tuyển vị trí sales',
};

describe('RecruitmentConversationService.saveMessage', () => {
  it('lưu tin nhắn mới và cập nhật lastMessageAt của hội thoại', async () => {
    const { service, messageRepo, conversationRepo } = setup();

    const result = await service.saveMessage(inbound);

    expect(result).toEqual({
      conversationId: 4,
      messageId: 900,
      applicationId: null,
      duplicate: false,
    });
    expect(messageRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        externalMessageId: 'msg-1',
        contentType: 'TEXT',
      }),
    );
    expect(conversationRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ lastMessageAt: expect.any(Date) }),
    );
  });

  it('trùng externalMessageId (OpenClaw retry) → trả tin cũ, không lưu thêm', async () => {
    const { service, messageRepo } = setup();
    messageRepo.findOne.mockResolvedValue({
      id: 777,
      externalMessageId: 'msg-1',
    });

    const result = await service.saveMessage(inbound);

    expect(result).toMatchObject({ messageId: 777, duplicate: true });
    expect(messageRepo.save).not.toHaveBeenCalled();
  });

  it('hai retry song song đụng unique index → request thua trả tin đã lưu', async () => {
    const { service, messageRepo } = setup();
    messageRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 778, externalMessageId: 'msg-1' });
    messageRepo.save.mockRejectedValueOnce({ code: '23505' });

    const result = await service.saveMessage(inbound);
    expect(result).toMatchObject({ messageId: 778, duplicate: true });
  });

  it('tin của ứng viên mà direction OUTBOUND → 400', async () => {
    const { service } = setup();
    await expect(
      service.saveMessage({ ...inbound, direction: MessageDirection.OUTBOUND }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SENDER_DIRECTION_MISMATCH' }),
    });
  });

  it('hội thoại thuộc ứng viên khác → 409', async () => {
    const { service, conversationRepo } = setup();
    conversationRepo.findOne.mockResolvedValue({ id: 4, candidateId: 99 });

    await expect(service.saveMessage(inbound)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'CONVERSATION_CANDIDATE_MISMATCH',
      }),
    });
  });

  it('applicationId không thuộc ứng viên → 400', async () => {
    const { service, applicationRepo } = setup();
    applicationRepo.findOne.mockResolvedValue({ id: 12, candidateId: 99 });

    await expect(
      service.saveMessage({ ...inbound, applicationId: 12 }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'APPLICATION_CANDIDATE_MISMATCH',
      }),
    });
  });
});
