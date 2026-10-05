import { ConfigService } from '@nestjs/config';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import {
  ViettelSinvoiceClient,
  ViettelSinvoiceError,
} from './viettel-sinvoice.client';
import type { ViettelInvoicePayload } from './viettel-invoice-payload';

interface Call {
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

describe('ViettelSinvoiceClient', () => {
  let server: Server;
  let baseUrl: string;
  let calls: Call[];
  let token: string;
  let draftReply: { status: number; body: unknown; delayMs?: number };
  /** Phản hồi khi cookie mang token cũ. */
  let staleTokenReply: { status: number; body: unknown };

  const payload = {
    generalInvoiceInfo: { transactionUuid: 'uuid-1' },
  } as unknown as ViettelInvoicePayload;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const call = {
          path: req.url ?? '',
          headers: req.headers,
          body: !raw
            ? null
            : req.headers['content-type'] === 'application/json'
              ? JSON.parse(raw)
              : raw,
        };
        calls.push(call);
        let reply: { status: number; body: unknown; delayMs?: number };
        if (call.path === '/auth/login') {
          reply =
            call.body?.password === 'secret-pass'
              ? { status: 200, body: { access_token: token } }
              : { status: 401, body: { message: 'bad credentials' } };
        } else if (req.headers.cookie !== `access_token=${token}`) {
          reply = staleTokenReply;
        } else {
          reply = draftReply;
        }
        setTimeout(() => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    calls = [];
    token = 'tok-1';
    staleTokenReply = { status: 401, body: { message: 'expired' } };
    // Phản hồi thật của Viettel khi tạo nháp thành công (đã đo trên tài khoản test).
    draftReply = {
      status: 200,
      body: { errorCode: '', description: '', result: {} },
    };
  });

  const client = (overrides: Record<string, string> = {}) =>
    new ViettelSinvoiceClient(
      new ConfigService({
        VIETTEL_SINVOICE_BASE_URL: `${baseUrl}/services/einvoiceapplication/api`,
        VIETTEL_SINVOICE_AUTH_URL: `${baseUrl}/auth/login`,
        VIETTEL_SINVOICE_USERNAME: 'kido',
        VIETTEL_SINVOICE_PASSWORD: 'secret-pass',
        VIETTEL_SINVOICE_TAX_CODE: '0109999999',
        VIETTEL_SINVOICE_TIMEOUT: '500',
        ...overrides,
      }),
    );

  it('đăng nhập 1 lần, gửi nháp 7.8 kèm cookie token, đúng URL theo MST', async () => {
    const viettel = client();
    await expect(viettel.createOrUpdateInvoiceDraft(payload)).resolves.toEqual(
      {},
    );
    await viettel.createOrUpdateInvoiceDraft(payload);

    expect(calls.filter((c) => c.path === '/auth/login')).toHaveLength(1);
    const drafts = calls.filter((c) => c.path !== '/auth/login');
    expect(drafts.map((c) => c.path)).toEqual([
      '/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createOrUpdateInvoiceDraft/0109999999',
      '/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createOrUpdateInvoiceDraft/0109999999',
    ]);
    expect(drafts[0].headers.cookie).toBe('access_token=tok-1');
    expect(drafts[0].body).toEqual(payload);
  });

  it('token hết hạn (401) → đăng nhập lại 1 lần rồi gửi lại', async () => {
    const viettel = client();
    await viettel.createOrUpdateInvoiceDraft(payload);
    token = 'tok-2';
    await viettel.createOrUpdateInvoiceDraft(payload);

    expect(calls.filter((c) => c.path === '/auth/login')).toHaveLength(2);
    expect(calls.at(-1)?.headers.cookie).toBe('access_token=tok-2');
  });

  it('token hết hạn kiểu Viettel (HTTP 500 "GENERAL") → đăng nhập lại 1 lần rồi gửi lại', async () => {
    // Bảng lỗi Viettel: 500 {"error":"Internal Server Error","message":"GENERAL"} = token hết hạn.
    staleTokenReply = {
      status: 500,
      body: { error: 'Internal Server Error', message: 'GENERAL' },
    };
    const viettel = client();
    await viettel.createOrUpdateInvoiceDraft(payload);
    token = 'tok-2';
    await expect(viettel.createOrUpdateInvoiceDraft(payload)).resolves.toEqual(
      {},
    );

    expect(calls.filter((c) => c.path === '/auth/login')).toHaveLength(2);
    expect(calls.at(-1)?.headers.cookie).toBe('access_token=tok-2');
  });

  it('token JWT sắp hết hạn → đăng nhập lại trước khi gửi, không chờ lỗi', async () => {
    const jwt = (expSeconds: number) =>
      [
        'eyJhbGciOiJIUzI1NiJ9',
        Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url'),
        'sig',
      ].join('.');
    const now = Math.floor(Date.now() / 1000);
    token = jwt(now + 30); // còn 30 giây — dưới ngưỡng làm mới 1 phút
    const viettel = client();
    await viettel.createOrUpdateInvoiceDraft(payload);
    token = jwt(now + 20 * 60);
    await viettel.createOrUpdateInvoiceDraft(payload);
    await viettel.createOrUpdateInvoiceDraft(payload);

    expect(calls.map((c) => c.path === '/auth/login')).toEqual([
      true,
      false,
      true,
      false,
      false,
    ]);
  });

  it('Viettel trả mã lỗi nghiệp vụ → ViettelSinvoiceError với mô tả của Viettel', async () => {
    draftReply = {
      status: 200,
      body: {
        errorCode: 'TEMPLATE_NOT_FOUND',
        description: 'Mẫu hóa đơn không tồn tại',
      },
    };
    await expect(
      client().createOrUpdateInvoiceDraft(payload),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
      message: 'Mẫu hóa đơn không tồn tại',
    });
  });

  it('HTTP 400 dạng {code, message: MÃ, data: mô tả} của Viettel → tách đúng mã và mô tả', async () => {
    draftReply = {
      status: 400,
      body: {
        code: 400,
        message: 'TRANSACTION_UUID_INVALID',
        data: 'Transaction Uuid đã được dùng để lập hóa đơn',
        errorCode: null,
      },
    };
    await expect(
      client().createOrUpdateInvoiceDraft(payload),
    ).rejects.toMatchObject({
      code: 'TRANSACTION_UUID_INVALID',
      message: 'Transaction Uuid đã được dùng để lập hóa đơn',
      httpStatus: 400,
    });
  });

  it('HTTP 500 có body lỗi → giữ mô tả của Viettel', async () => {
    draftReply = {
      status: 500,
      body: { code: 500, message: 'Lỗi hệ thống Viettel' },
    };
    await expect(
      client().createOrUpdateInvoiceDraft(payload),
    ).rejects.toMatchObject({
      code: '500',
      message: 'Lỗi hệ thống Viettel',
      httpStatus: 500,
    });
  });

  it('quá thời gian chờ → TIMEOUT', async () => {
    draftReply = { status: 200, body: {}, delayMs: 1500 };
    await expect(
      client().createOrUpdateInvoiceDraft(payload),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('tra cứu hóa đơn đã phát hành theo transactionUuid (7.21, form-urlencoded)', async () => {
    draftReply = {
      status: 200,
      body: {
        errorCode: null,
        description: null,
        transactionUuid: 'uuid-1',
        result: [{ invoiceNo: 'C26TIS12', status: 'Hóa đơn gốc' }],
      },
    };
    await expect(client().searchIssuedInvoices('uuid-1')).resolves.toEqual([
      { invoiceNo: 'C26TIS12', status: 'Hóa đơn gốc' },
    ]);
    const call = calls.at(-1)!;
    expect(call.path).toBe(
      '/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid',
    );
    expect(call.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(call.body).toBe('supplierTaxCode=0109999999&transactionUuid=uuid-1');
  });

  it('chưa phát hành (nháp, đã xóa, uuid lạ) → Viettel trả 400 NOT_FOUND_DATA → rỗng', async () => {
    draftReply = {
      status: 400,
      body: {
        code: 400,
        message: 'NOT_FOUND_DATA',
        data: 'Không tìm thấy bản ghi',
      },
    };
    await expect(client().searchIssuedInvoices('uuid-1')).resolves.toEqual([]);
  });

  it('sai tài khoản → AUTH_ERROR, không lộ mật khẩu trong lỗi', async () => {
    const error = await client({ VIETTEL_SINVOICE_PASSWORD: 'wrong-pass' })
      .createOrUpdateInvoiceDraft(payload)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViettelSinvoiceError);
    expect(error).toMatchObject({ code: 'AUTH_ERROR' });
    expect(JSON.stringify(error)).not.toContain('wrong-pass');
    expect((error as Error).message).not.toContain('wrong-pass');
  });
});
