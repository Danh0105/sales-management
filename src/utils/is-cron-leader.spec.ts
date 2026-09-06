import { isCronLeader } from './is-cron-leader';

describe('isCronLeader', () => {
  const original = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('true khi NODE_ENV=production (process sales-management)', () => {
    process.env.NODE_ENV = 'production';
    expect(isCronLeader()).toBe(true);
  });

  it.each(['development', undefined, ''])(
    'false khi NODE_ENV=%s (process sales-be/dev/test) — tránh gửi trùng vì dùng chung DB với prod',
    (value) => {
      process.env.NODE_ENV = value as any;
      expect(isCronLeader()).toBe(false);
    },
  );
});
