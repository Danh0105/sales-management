import {
  assertRecruitmentAiConfig,
  formatRecruitmentSubject,
  parseRecruitmentSubject,
  REQUIRE_SUBJECT_CONFIG_ERROR,
} from './recruitment-ai-subject';

describe('parseRecruitmentSubject', () => {
  it('đúng định dạng zalo:<oaId>:<userId>', () => {
    const subject = parseRecruitmentSubject('zalo:4321:8765');
    expect(subject).toEqual({ channel: 'zalo', oaId: '4321', userId: '8765' });
    expect(formatRecruitmentSubject(subject!)).toBe('zalo:4321:8765');
  });

  it.each([
    ['thiếu phần', 'zalo:4321'],
    ['kênh khác', 'facebook:1:2'],
    ['ký tự lạ', 'zalo:43 21:8765'],
    ['thêm phần thừa', 'zalo:1:2:3'],
    ['chuỗi rỗng', ''],
    ['không phải chuỗi (header lặp)', ['zalo:1:2', 'zalo:1:3']],
    ['OA dành riêng cho dữ liệu cũ', 'zalo:legacy:8765'],
    ['userId quá dài', `zalo:1:${'9'.repeat(101)}`],
  ])('%s → null', (_label, raw) => {
    expect(parseRecruitmentSubject(raw)).toBeNull();
  });
});

describe('assertRecruitmentAiConfig (fail-closed)', () => {
  const get = (values: Record<string, string>) => (key: string) => values[key];

  it('production + bật API AI + thiếu REQUIRE_SUBJECT → không khởi động', () => {
    expect(() =>
      assertRecruitmentAiConfig(
        get({ NODE_ENV: 'production', RECRUITMENT_AI_ENABLED: 'true' }),
      ),
    ).toThrow(REQUIRE_SUBJECT_CONFIG_ERROR);
    expect(() =>
      assertRecruitmentAiConfig(
        get({
          NODE_ENV: 'production',
          RECRUITMENT_AI_ENABLED: 'true',
          RECRUITMENT_AI_REQUIRE_SUBJECT: 'false',
        }),
      ),
    ).toThrow(REQUIRE_SUBJECT_CONFIG_ERROR);
  });

  it.each([
    [
      {
        NODE_ENV: 'production',
        RECRUITMENT_AI_ENABLED: 'true',
        RECRUITMENT_AI_REQUIRE_SUBJECT: 'true',
      },
    ],
    [{ NODE_ENV: 'production', RECRUITMENT_AI_ENABLED: 'false' }],
    [{ NODE_ENV: 'staging', RECRUITMENT_AI_ENABLED: 'true' }],
  ])('cấu hình hợp lệ %j → khởi động được', (values) => {
    expect(() => assertRecruitmentAiConfig(get(values))).not.toThrow();
  });
});
