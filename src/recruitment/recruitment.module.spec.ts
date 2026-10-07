import { REQUIRE_SUBJECT_CONFIG_ERROR } from './ai/recruitment-ai-subject';
import { RECRUITMENT_ZALO_CONFIG_ERROR } from './channels/zalo-recruitment-event';
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

  it('bật webhook Zalo OA tuyển dụng mà thiếu cấu hình OA → không khởi động', () => {
    expect(() =>
      moduleWith({ RECRUITMENT_ZALO_ENABLED: 'true' }).onModuleInit(),
    ).toThrow(RECRUITMENT_ZALO_CONFIG_ERROR);
  });
});
