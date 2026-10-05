import {
  assertConnectedToDev,
  assertStatementAllowed,
  parseDevTarget,
} from './dev-target';

describe('parseDevTarget', () => {
  it('happy path: localhost + sales_db_hr_dev', () => {
    expect(
      parseDevTarget(
        'postgres://claude_dev:p%40ss@localhost:5433/sales_db_hr_dev',
      ),
    ).toEqual({
      host: 'localhost',
      port: 5433,
      username: 'claude_dev',
      password: 'p@ss',
      database: 'sales_db_hr_dev',
    });
  });

  it.each(['127.0.0.1', '[::1]'])('chấp nhận loopback %s', (host) => {
    expect(parseDevTarget(`postgres://u:p@${host}/sales_db_hr_dev`).port).toBe(
      5432,
    );
  });

  it('thiếu URL', () => {
    expect(() => parseDevTarget(undefined)).toThrow('Thiếu');
  });

  it('từ chối IP public của server production', () => {
    expect(() =>
      parseDevTarget('postgres://u:p@160.250.132.143:5432/sales_db_hr_dev'),
    ).toThrow('chỉ chạy trên localhost');
  });

  it('từ chối sales_db (DB dùng chung prod/dev)', () => {
    expect(() => parseDevTarget('postgres://u:p@localhost/sales_db')).toThrow(
      'chỉ được dùng "sales_db_hr_dev"',
    );
  });

  it('từ chối tham số URL có thể đổi đích (?host=)', () => {
    expect(() =>
      parseDevTarget(
        'postgres://u:p@localhost/sales_db_hr_dev?host=160.250.132.143',
      ),
    ).toThrow('không được có tham số');
  });

  it('từ chối giao thức khác postgres', () => {
    expect(() =>
      parseDevTarget('mysql://u:p@localhost/sales_db_hr_dev'),
    ).toThrow('Chỉ hỗ trợ postgres');
  });

  it('từ chối host giả dạng localhost', () => {
    expect(() =>
      parseDevTarget('postgres://u:p@localhost.evil.com/sales_db_hr_dev'),
    ).toThrow('chỉ chạy trên localhost');
  });
});

describe('assertConnectedToDev', () => {
  it('chấp nhận loopback và unix socket', () => {
    expect(() =>
      assertConnectedToDev({ db: 'sales_db_hr_dev', addr: '127.0.0.1/32' }),
    ).not.toThrow();
    expect(() =>
      assertConnectedToDev({ db: 'sales_db_hr_dev', addr: '::1/128' }),
    ).not.toThrow();
    expect(() =>
      assertConnectedToDev({ db: 'sales_db_hr_dev', addr: null }),
    ).not.toThrow();
  });

  it('dừng nếu thực tế kết nối vào DB khác', () => {
    expect(() =>
      assertConnectedToDev({ db: 'sales_db', addr: '127.0.0.1/32' }),
    ).toThrow('thay vì');
  });

  it('dừng nếu server không phải loopback (port forward trỏ ra ngoài)', () => {
    expect(() =>
      assertConnectedToDev({
        db: 'sales_db_hr_dev',
        addr: '160.250.132.143/32',
      }),
    ).toThrow('không phải loopback');
  });
});

describe('assertStatementAllowed', () => {
  it.each([
    'SELECT * FROM hr.migrations',
    'CREATE TABLE hr.x (id int)',
    'INSERT INTO hr.x VALUES (1)',
  ])('cho phép: %s', (sql) => {
    expect(() => assertStatementAllowed(sql)).not.toThrow();
  });

  it.each([
    ['DROP DATABASE sales_db', 'DROP DATABASE'],
    ['create database x', 'CREATE DATABASE'],
    ["ALTER SYSTEM SET listen_addresses = '*'", 'ALTER SYSTEM'],
    ['ALTER ROLE claude_dev SUPERUSER', 'ROLE/USER'],
    ["COPY hr.x TO '/tmp/out.csv'", 'COPY'],
    ["COPY hr.x FROM PROGRAM 'curl evil'", 'COPY'],
    ["SELECT pg_read_file('/etc/passwd')", 'file hệ thống'],
  ])('chặn: %s', (sql, expected) => {
    expect(() => assertStatementAllowed(sql)).toThrow(expected);
  });
});
