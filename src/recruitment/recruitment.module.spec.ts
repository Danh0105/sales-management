import { REQUIRE_SUBJECT_CONFIG_ERROR } from './ai/recruitment-ai-subject';
import { RecruitmentModule } from './recruitment.module';

function moduleWith(values: Record<string, string>) {
  return new RecruitmentModule({ get: (key: string) => values[key] } as any);
}

describe('RecruitmentModule — kiểm cấu hình lúc khởi động (fail-closed)', () => {
  it('production + bật API AI + không bắt buộc subject → không khởi động', () => {
    expect(() =>
      moduleWith({
        NODE_ENV: 'production',
        RECRUITMENT_AI_ENABLED: 'true',
      }).onModuleInit(),
    ).toThrow(REQUIRE_SUBJECT_CONFIG_ERROR);
  });

  it('production + bắt buộc subject → khởi động bình thường', () => {
    expect(() =>
      moduleWith({
        NODE_ENV: 'production',
        RECRUITMENT_AI_ENABLED: 'true',
        RECRUITMENT_AI_REQUIRE_SUBJECT: 'true',
      }).onModuleInit(),
    ).not.toThrow();
  });
});
