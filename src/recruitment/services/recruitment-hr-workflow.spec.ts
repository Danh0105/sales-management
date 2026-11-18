import { InterviewStatus } from '../recruitment.enums';
import { RecruitmentInterviewService } from './recruitment-interview.service';
import { RecruitmentHrConsoleService } from '../channels/recruitment-hr-console.service';

describe('HR workflow contract', () => {
  it.each([
    [
      InterviewStatus.PROPOSED,
      [InterviewStatus.CONFIRMED, InterviewStatus.CANCELLED],
    ],
    [
      InterviewStatus.CONFIRMED,
      [
        InterviewStatus.COMPLETED,
        InterviewStatus.CANCELLED,
        InterviewStatus.NO_SHOW,
      ],
    ],
    [InterviewStatus.COMPLETED, []],
    [InterviewStatus.CANCELLED, []],
    [InterviewStatus.NO_SHOW, []],
  ])(
    'interview %s exposes backend-owned next actions',
    async (status, expected) => {
      const repo = { findOne: jest.fn().mockResolvedValue({ id: 8, status }) };
      const service = new RecruitmentInterviewService(
        repo as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      expect(await service.findOne(8)).toMatchObject({
        allowedNextStatuses: expected,
      });
    },
  );

  it('rejects moving an unbooked slot into the past without saving', async () => {
    const slotRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 3,
        bookedCount: 0,
        startAt: new Date('2099-01-01'),
        endAt: new Date('2099-01-02'),
      }),
      save: jest.fn(),
    };
    const service = new RecruitmentInterviewService(
      {} as any,
      slotRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        transaction: async (fn: any) => fn({ getRepository: () => slotRepo }),
      } as any,
      {} as any,
      {} as any,
    );
    await expect(
      service.updateSlot(
        3,
        {
          startAt: '2020-01-01T09:00:00+07:00',
          endAt: '2020-01-01T10:00:00+07:00',
        },
        {} as any,
      ),
    ).rejects.toMatchObject({ response: { code: 'SLOT_IN_PAST' } });
    expect(slotRepo.save).not.toHaveBeenCalled();
    expect(slotRepo.findOne).toHaveBeenCalledWith({
      where: { id: 3 },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('slot changes audit in the same transaction and cannot overwrite booking count', async () => {
    const slotRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: 3, bookedCount: 2, capacity: 3 }),
      save: jest.fn(async (value) => value),
    };
    const em = { getRepository: () => slotRepo };
    const audit = { recordMandatory: jest.fn() };
    const service = new RecruitmentInterviewService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { transaction: async (fn: any) => fn(em) } as any,
      {} as any,
      audit as any,
    );
    await expect(
      service.updateSlot(3, { capacity: 1 }, {} as any),
    ).rejects.toMatchObject({ response: { code: 'CAPACITY_BELOW_BOOKED' } });
    expect(slotRepo.save).not.toHaveBeenCalled();
    await service.updateSlot(3, { isActive: false }, {} as any);
    expect(slotRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ bookedCount: 2, isActive: false }),
    );
    expect(audit.recordMandatory).toHaveBeenCalledWith(
      em,
      expect.objectContaining({ action: 'INTERVIEW_SLOT_UPDATE' }),
    );
  });

  it('candidate conversation filtering uses exact identity for both rows and count', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);
    const service = new RecruitmentHrConsoleService({ query } as any);
    await service.listConversations({ candidateId: 47, page: 2, limit: 20 });
    expect(query.mock.calls[0][0]).toContain('c.candidate_id = $4');
    expect(query.mock.calls[0][0]).toContain('LIMIT $5 OFFSET $6');
    expect(query.mock.calls[0][1]).toEqual([null, null, false, 47, 20, 20]);
    expect(query.mock.calls[1][1]).toEqual([null, null, false, 47]);
  });
});
