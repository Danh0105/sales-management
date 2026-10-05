import { ConflictException, ForbiddenException } from '@nestjs/common';

import {
  allowedNextStatuses,
  assertApplicationTransition,
  canTransition,
} from './application-status.state-machine';
import {
  ApplicationStatus as S,
  RecruitmentActorType,
} from './recruitment.enums';

const { AI, HR, SYSTEM } = RecruitmentActorType;

describe('application status state machine', () => {
  it('luồng chính hợp lệ cho HR: NEW → ... → HIRED', () => {
    const path = [
      S.NEW,
      S.COLLECTING_INFO,
      S.SCREENING,
      S.QUALIFIED,
      S.INTERVIEW,
      S.OFFER,
      S.HIRED,
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(() =>
        assertApplicationTransition(path[i], path[i + 1], HR),
      ).not.toThrow();
    }
  });

  it('AI đi được phần thu thập + sàng lọc', () => {
    expect(canTransition(S.NEW, S.COLLECTING_INFO, AI)).toBe(true);
    expect(canTransition(S.COLLECTING_INFO, S.SCREENING, AI)).toBe(true);
    expect(canTransition(S.SCREENING, S.QUALIFIED, AI)).toBe(true);
    expect(canTransition(S.SCREENING, S.NEEDS_HR_REVIEW, AI)).toBe(true);
    expect(canTransition(S.SCREENING, S.COLLECTING_INFO, AI)).toBe(true);
    expect(canTransition(S.INTERVIEW, S.NEEDS_HR_REVIEW, AI)).toBe(true);
  });

  it.each([
    [S.INTERVIEW, S.OFFER],
    [S.OFFER, S.HIRED],
    [S.SCREENING, S.REJECTED],
    [S.QUALIFIED, S.WITHDRAWN],
  ])('AI không được ra quyết định cuối: %s → %s', (from, to) => {
    expect(() => assertApplicationTransition(from, to, AI)).toThrow(
      ForbiddenException,
    );
    // SYSTEM (bước tự sinh trong luồng AI) cũng không được.
    expect(canTransition(from, to, SYSTEM)).toBe(false);
  });

  it('AI chỉ sang INTERVIEW khi ứng viên đã xác nhận lịch', () => {
    expect(canTransition(S.QUALIFIED, S.INTERVIEW, AI)).toBe(false);
    expect(
      canTransition(S.QUALIFIED, S.INTERVIEW, AI, { interviewConfirmed: true }),
    ).toBe(true);
    expect(canTransition(S.QUALIFIED, S.INTERVIEW, HR)).toBe(true);
  });

  it('sau handoff (NEEDS_HR_REVIEW) chỉ HR được chuyển tiếp', () => {
    expect(allowedNextStatuses(S.NEEDS_HR_REVIEW, AI)).toEqual([]);
    expect(allowedNextStatuses(S.NEEDS_HR_REVIEW, HR)).toEqual(
      expect.arrayContaining([
        S.COLLECTING_INFO,
        S.QUALIFIED,
        S.INTERVIEW,
        S.REJECTED,
      ]),
    );
  });

  it('chuyển không có trong luồng → 409', () => {
    try {
      assertApplicationTransition(S.NEW, S.OFFER, HR);
      fail('phải ném lỗi');
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'INVALID_STATUS_TRANSITION',
      });
    }
  });

  it('trạng thái kết thúc không đi đâu được nữa', () => {
    for (const terminal of [S.HIRED, S.REJECTED, S.WITHDRAWN]) {
      expect(allowedNextStatuses(terminal, HR)).toEqual([]);
    }
  });

  it('giữ nguyên trạng thái là lỗi STATUS_UNCHANGED', () => {
    expect(() =>
      assertApplicationTransition(S.QUALIFIED, S.QUALIFIED, HR),
    ).toThrow(ConflictException);
  });
});
