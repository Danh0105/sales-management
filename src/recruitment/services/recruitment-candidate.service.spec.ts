import { BadRequestException, ConflictException } from '@nestjs/common';

import { CandidateSource, RecruitmentActorType } from '../recruitment.enums';
import type { RecruitmentActor } from '../recruitment.roles';
import { RecruitmentCandidateService } from './recruitment-candidate.service';

const HR: RecruitmentActor = {
  type: RecruitmentActorType.HR,
  employeeId: 2,
  name: 'Nhân sự',
  roles: ['nhansu'],
};

const existing = {
  id: 7,
  fullName: 'Nguyễn Văn A',
  phone: '0901234567',
  email: 'a@example.com',
  zaloUserId: 'zalo-123',
  source: CandidateSource.WEBSITE,
  notes: 'Ghi chú nội bộ HR',
  skills: [],
  metadata: {},
  suspectedDuplicateIds: [],
  deletionRequestedAt: null,
  aiStoppedAt: null,
};

function setup() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const candidateRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((v) => ({ ...v })),
    save: jest.fn(async (v) => ({ id: v.id ?? 50, ...v })),
    createQueryBuilder: jest.fn().mockReturnValue(qb),
  } as any;
  const applicationRepo = { find: jest.fn().mockResolvedValue([]) } as any;
  const audit = { record: jest.fn() } as any;
  const service = new RecruitmentCandidateService(
    candidateRepo,
    applicationRepo,
    audit,
  );
  return { service, candidateRepo, qb, audit };
}

describe('RecruitmentCandidateService — HR', () => {
  it('tạo ứng viên, chuẩn hoá SĐT/email và ghi audit', async () => {
    const { service, candidateRepo, audit } = setup();

    const saved = await service.create(
      { fullName: 'Trần B', phone: '+84 90 111 2222', email: 'B@Example.com' },
      HR,
    );

    expect(saved).toMatchObject({
      phone: '0901112222',
      email: 'b@example.com',
      source: CandidateSource.MANUAL,
      suspectedDuplicateIds: [],
    });
    expect(candidateRepo.save).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CANDIDATE_CREATE', actor: HR }),
    );
  });

  it('trùng SĐT → 409 POSSIBLE_DUPLICATE, không lưu', async () => {
    const { service, candidateRepo, qb } = setup();
    qb.getMany.mockResolvedValue([existing]);

    await expect(
      service.create({ fullName: 'Người khác', phone: '0901234567' }, HR),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'POSSIBLE_DUPLICATE',
        duplicates: [expect.objectContaining({ id: 7, matchedOn: ['phone'] })],
      }),
    });
    expect(candidateRepo.save).not.toHaveBeenCalled();
  });

  it('allowDuplicate=true → vẫn tạo nhưng gắn cờ nghi trùng', async () => {
    const { service, qb } = setup();
    qb.getMany.mockResolvedValue([existing]);

    const saved = await service.create(
      { fullName: 'Người khác', phone: '0901234567', allowDuplicate: true },
      HR,
    );
    expect(saved.suspectedDuplicateIds).toEqual([7]);
  });

  it('trùng zaloUserId luôn bị chặn', async () => {
    const { service, candidateRepo } = setup();
    candidateRepo.findOne.mockResolvedValue(existing);

    await expect(
      service.create({ zaloUserId: 'zalo-123', allowDuplicate: true }, HR),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('SĐT không hợp lệ → 400 INVALID_PHONE', async () => {
    const { service } = setup();
    await expect(service.create({ phone: '12345' }, HR)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('cập nhật: ghi before/after vào audit', async () => {
    const { service, candidateRepo, audit } = setup();
    candidateRepo.findOne.mockResolvedValue({ ...existing });

    const saved = await service.update(
      7,
      { location: 'Cà Mau', notes: 'Đã gọi' },
      HR,
    );

    expect(saved).toMatchObject({ location: 'Cà Mau', notes: 'Đã gọi' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CANDIDATE_UPDATE',
        before: expect.objectContaining({ notes: 'Ghi chú nội bộ HR' }),
        after: expect.objectContaining({ notes: 'Đã gọi' }),
      }),
    );
  });
});

describe('RecruitmentCandidateService — AI', () => {
  it('tìm lại ứng viên cũ theo zaloUserId (retry idempotent), không lộ ghi chú HR', async () => {
    const { service, candidateRepo } = setup();
    candidateRepo.findOne.mockResolvedValue(existing);

    const result = await service.aiFindOrCreate({
      zaloUserId: 'zalo-123',
      fullName: 'A',
    });

    expect(result).toMatchObject({ outcome: 'EXISTING', created: false });
    expect(result.candidate).toMatchObject({ id: 7 });
    expect(result.candidate).not.toHaveProperty('notes');
    expect(result.candidate).not.toHaveProperty('suspectedDuplicateIds');
    expect(candidateRepo.save).not.toHaveBeenCalled();
  });

  it('chưa có → tạo mới với nguồn ZALO', async () => {
    const { service, audit } = setup();

    const result = await service.aiFindOrCreate({
      zaloUserId: 'zalo-999',
      fullName: 'Lê C',
    });

    expect(result).toMatchObject({ outcome: 'CREATED', created: true });
    expect(result.candidate).toMatchObject({
      source: CandidateSource.ZALO,
      fullName: 'Lê C',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CANDIDATE_CREATE',
        actor: expect.objectContaining({ type: RecruitmentActorType.AI }),
      }),
    );
  });

  it('trùng SĐT: chỉ báo POSSIBLE_DUPLICATE, không trả id/tên/hồ sơ cũ', async () => {
    const { service, candidateRepo, qb } = setup();
    qb.getMany.mockResolvedValue([existing]);

    const result = await service.aiFindOrCreate({
      zaloUserId: 'zalo-new',
      phone: '0901234567',
    });

    expect(result).toEqual({
      outcome: 'POSSIBLE_DUPLICATE',
      created: false,
      candidate: null,
      matchedOn: ['phone'],
      possibleDuplicateCount: 1,
      message: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('Nguyễn Văn A');
    expect(JSON.stringify(result)).not.toContain('"id":7');
    expect(candidateRepo.save).not.toHaveBeenCalled();
  });

  it('confirmNewCandidate=true → tạo hồ sơ mới gắn cờ nghi trùng, không gộp', async () => {
    const { service, candidateRepo, qb } = setup();
    qb.getMany.mockResolvedValue([existing]);

    const result = await service.aiFindOrCreate({
      zaloUserId: 'zalo-new',
      phone: '0901234567',
      confirmNewCandidate: true,
    });

    expect(result).toMatchObject({
      outcome: 'CREATED',
      suspectedDuplicate: true,
    });
    expect(candidateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        suspectedDuplicateIds: [7],
        zaloUserId: 'zalo-new',
      }),
    );
  });

  it('hai request song song cùng zaloUserId → request thua trả lại ứng viên đã tạo', async () => {
    const { service, candidateRepo } = setup();
    candidateRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...existing, zaloUserId: 'zalo-race' });
    candidateRepo.save.mockRejectedValueOnce({ code: '23505' });

    const result = await service.aiFindOrCreate({ zaloUserId: 'zalo-race' });
    expect(result).toMatchObject({ outcome: 'EXISTING', created: false });
  });

  it('thiếu cả zaloUserId, phone, email → 400', async () => {
    const { service } = setup();
    await expect(
      service.aiFindOrCreate({ fullName: 'Ẩn danh' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('AI cập nhật SĐT trùng người khác: vẫn lưu, gắn cờ, chỉ báo matchedOn', async () => {
    const { service, candidateRepo, qb } = setup();
    candidateRepo.findOne.mockResolvedValue({
      ...existing,
      id: 9,
      phone: null,
      zaloUserId: 'z9',
    });
    qb.getMany.mockResolvedValue([existing]);

    const result = await service.aiUpdate(9, {
      phone: '0901234567',
      totalExperienceMonths: 24,
    });

    expect(result).toMatchObject({
      possibleDuplicate: true,
      matchedOn: ['phone'],
    });
    expect(result.candidate).toMatchObject({
      phone: '0901234567',
      totalExperienceMonths: 24,
    });
    expect(candidateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ suspectedDuplicateIds: [7] }),
    );
  });

  it('ứng viên đã xin xoá dữ liệu → AI không sửa được', async () => {
    const { service, candidateRepo } = setup();
    candidateRepo.findOne.mockResolvedValue({
      ...existing,
      aiStoppedAt: new Date(),
    });

    await expect(
      service.aiUpdate(7, { location: 'Cà Mau' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_STOPPED_FOR_CANDIDATE' }),
    });
  });
});
