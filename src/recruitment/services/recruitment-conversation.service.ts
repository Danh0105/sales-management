import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';

import type { AiSaveMessageDto } from '../dto/ai.dto';
import { RecruitmentApplication } from '../entities/recruitment-application.entity';
import { RecruitmentCandidate } from '../entities/recruitment-candidate.entity';
import { RecruitmentConversation } from '../entities/recruitment-conversation.entity';
import { RecruitmentJob } from '../entities/recruitment-job.entity';
import { RecruitmentMessage } from '../entities/recruitment-message.entity';
import {
  ConversationStatus,
  INACTIVE_APPLICATION_STATUSES,
  MessageContentType,
  MessageDirection,
  MessageSenderType,
} from '../recruitment.enums';
import { isUniqueViolation } from '../recruitment.views';
import { RecruitmentApplicationService } from './recruitment-application.service';

/** Ứng viên luôn là chiều vào; AI/HR luôn là chiều ra. SYSTEM thì tuỳ. */
const EXPECTED_DIRECTION: Partial<Record<MessageSenderType, MessageDirection>> =
  {
    [MessageSenderType.CANDIDATE]: MessageDirection.INBOUND,
    [MessageSenderType.AI]: MessageDirection.OUTBOUND,
    [MessageSenderType.HR]: MessageDirection.OUTBOUND,
  };

@Injectable()
export class RecruitmentConversationService {
  constructor(
    @InjectRepository(RecruitmentConversation)
    private readonly conversationRepo: Repository<RecruitmentConversation>,
    @InjectRepository(RecruitmentMessage)
    private readonly messageRepo: Repository<RecruitmentMessage>,
    @InjectRepository(RecruitmentCandidate)
    private readonly candidateRepo: Repository<RecruitmentCandidate>,
    @InjectRepository(RecruitmentApplication)
    private readonly applicationRepo: Repository<RecruitmentApplication>,
    @InjectRepository(RecruitmentJob)
    private readonly jobRepo: Repository<RecruitmentJob>,
    private readonly applications: RecruitmentApplicationService,
  ) {}

  /**
   * Lưu một tin nhắn. Luôn được phép — kể cả khi hồ sơ đã chuyển HR hay ứng
   * viên xin xoá dữ liệu — vì HR cần đọc được ứng viên đã nói gì.
   *
   * Idempotent theo `externalMessageId`: retry trả `duplicate: true` và id
   * tin nhắn đã lưu, không tạo dòng mới.
   */
  async saveMessage(dto: AiSaveMessageDto) {
    const expected = EXPECTED_DIRECTION[dto.senderType];
    if (expected && expected !== dto.direction) {
      throw new BadRequestException({
        code: 'SENDER_DIRECTION_MISMATCH',
        message: `Tin nhắn từ ${dto.senderType} phải có direction ${expected}`,
      });
    }

    const candidate = await this.candidateRepo.findOne({
      where: { id: dto.candidateId },
    });
    if (!candidate) {
      throw new NotFoundException({
        code: 'CANDIDATE_NOT_FOUND',
        message: `Không tìm thấy ứng viên #${dto.candidateId}`,
      });
    }
    if (dto.applicationId) {
      const application = await this.applicationRepo.findOne({
        where: { id: dto.applicationId },
      });
      if (!application || application.candidateId !== dto.candidateId) {
        throw new BadRequestException({
          code: 'APPLICATION_CANDIDATE_MISMATCH',
          message: 'applicationId không thuộc ứng viên này',
        });
      }
    }

    const conversation = await this.resolveConversation(dto);

    if (dto.externalMessageId) {
      const existing = await this.messageRepo.findOne({
        where: {
          conversationId: conversation.id,
          externalMessageId: dto.externalMessageId,
        },
      });
      if (existing) return this.result(conversation, existing, true);
    }

    let message: RecruitmentMessage;
    try {
      message = await this.messageRepo.save(
        this.messageRepo.create({
          conversationId: conversation.id,
          externalMessageId: dto.externalMessageId ?? null,
          senderType: dto.senderType,
          direction: dto.direction,
          content: dto.content,
          contentType: dto.contentType ?? MessageContentType.TEXT,
          metadata: dto.metadata ?? {},
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error) && dto.externalMessageId) {
        const raced = await this.messageRepo.findOne({
          where: {
            conversationId: conversation.id,
            externalMessageId: dto.externalMessageId,
          },
        });
        if (raced) return this.result(conversation, raced, true);
      }
      throw error;
    }

    conversation.lastMessageAt = message.createdAt ?? new Date();
    if (!conversation.applicationId && dto.applicationId) {
      conversation.applicationId = dto.applicationId;
    }
    await this.conversationRepo.save(conversation);

    return this.result(conversation, message, false);
  }

  /** Context theo hội thoại: hồ sơ gắn với hội thoại, hoặc hồ sơ đang mở mới nhất của ứng viên. */
  async getContext(conversationId: number) {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException({
        code: 'CONVERSATION_NOT_FOUND',
        message: `Không tìm thấy hội thoại #${conversationId}`,
      });
    }
    const candidate = await this.candidateRepo.findOneOrFail({
      where: { id: conversation.candidateId },
    });

    const application = conversation.applicationId
      ? await this.applicationRepo.findOne({
          where: { id: conversation.applicationId },
        })
      : await this.applicationRepo.findOne({
          where: {
            candidateId: candidate.id,
            status: Not(In([...INACTIVE_APPLICATION_STATUSES])),
          },
          order: { updatedAt: 'DESC' },
        });
    const job = application
      ? await this.jobRepo.findOne({
          where: { id: application.jobId },
          relations: { department: true },
        })
      : null;

    return this.applications.buildContext({
      candidate,
      application,
      job,
      conversation,
    });
  }

  private async resolveConversation(
    dto: AiSaveMessageDto,
  ): Promise<RecruitmentConversation> {
    if (dto.externalConversationId) {
      const where = {
        channel: dto.channel,
        externalConversationId: dto.externalConversationId,
      };
      const found = await this.conversationRepo.findOne({ where });
      if (found) return this.assertOwner(found, dto.candidateId);

      try {
        return await this.conversationRepo.save(
          this.conversationRepo.create({
            ...where,
            candidateId: dto.candidateId,
            applicationId: dto.applicationId ?? null,
            status: ConversationStatus.ACTIVE,
          }),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await this.conversationRepo.findOneOrFail({ where });
        return this.assertOwner(raced, dto.candidateId);
      }
    }

    // Kênh không có id hội thoại: dùng hội thoại đang mở gần nhất trên kênh đó.
    const latest = await this.conversationRepo.findOne({
      where: {
        candidateId: dto.candidateId,
        channel: dto.channel,
        status: ConversationStatus.ACTIVE,
        externalConversationId: IsNull(),
      },
      order: { id: 'DESC' },
    });
    if (latest) return latest;

    return this.conversationRepo.save(
      this.conversationRepo.create({
        candidateId: dto.candidateId,
        applicationId: dto.applicationId ?? null,
        channel: dto.channel,
        externalConversationId: null,
        status: ConversationStatus.ACTIVE,
      }),
    );
  }

  private assertOwner(
    conversation: RecruitmentConversation,
    candidateId: number,
  ) {
    if (conversation.candidateId !== candidateId) {
      throw new ConflictException({
        code: 'CONVERSATION_CANDIDATE_MISMATCH',
        message: 'Hội thoại này thuộc về ứng viên khác',
      });
    }
    return conversation;
  }

  private result(
    conversation: RecruitmentConversation,
    message: RecruitmentMessage,
    duplicate: boolean,
  ) {
    return {
      conversationId: conversation.id,
      messageId: message.id,
      applicationId: conversation.applicationId,
      duplicate,
    };
  }
}
