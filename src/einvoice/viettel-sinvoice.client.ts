import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { getViettelSinvoiceConfig } from './viettel-sinvoice.config';
import type { ViettelInvoicePayload } from './viettel-invoice-payload';

/** Mục 7.8 tài liệu Viettel S-Invoice v2.44: tạo mới/cập nhật hóa đơn nháp theo transactionUuid. */
export const DRAFT_ENDPOINT =
  'InvoiceAPI/InvoiceWS/createOrUpdateInvoiceDraft/';

/** Mục 7.21: tra cứu hóa đơn đã phát hành theo transactionUuid. */
export const SEARCH_BY_UUID_ENDPOINT =
  'InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid';

const NOT_FOUND = 'NOT_FOUND_DATA';

/**
 * Token hết hạn: Viettel trả HTTP 500 `{ message: "GENERAL" }` thay vì 401
 * (bảng lỗi mục 8, dòng 8). Token sống 20 phút (đo 02/10/2026).
 */
const TOKEN_EXPIRED_MESSAGE = 'GENERAL';

/** Đăng nhập lại trước khi token hết hạn chừng này. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Viettel trả mã này khi transactionUuid đã được dùng để lập hóa đơn (kể cả nháp). */
export const TRANSACTION_UUID_USED = 'TRANSACTION_UUID_INVALID';

export interface ViettelDraftResult {
  transactionID?: string | null;
  invoiceNo?: string | null;
  reservationCode?: string | null;
}

/** Hóa đơn đã phát hành (đã có số) tìm thấy theo transactionUuid. */
export interface ViettelIssuedInvoice {
  invoiceNo?: string | null;
  reservationCode?: string | null;
  issueDate?: number | null;
  status?: string | null;
}

export class ViettelSinvoiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = ViettelSinvoiceError.name;
  }
}

/**
 * Thành công: `{ errorCode: "", description: "", result: {} }`.
 * Lỗi nghiệp vụ: HTTP 400 `{ code: 400, message: "INVOICE_SERIAL_NOT_FOUND", data: "Ký hiệu hóa đơn không tồn tại" }`
 * hoặc HTTP 200 kèm `errorCode`/`description`.
 */
interface ViettelEnvelope {
  errorCode?: string | number | null;
  code?: string | number | null;
  description?: string | null;
  message?: string | null;
  result?: unknown;
  data?: unknown;
}

const SUCCESS_CODES = ['0', '00', '200', '201', 'SUCCESS', 'OK'];

@Injectable()
export class ViettelSinvoiceClient {
  private readonly logger = new Logger(ViettelSinvoiceClient.name);
  private token: string | null = null;
  /** Hạn token (ms) đọc từ `exp` của JWT; null nếu không đọc được. */
  private tokenExpiresAt: number | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly configService: ConfigService) {}

  async createOrUpdateInvoiceDraft(
    payload: ViettelInvoicePayload,
  ): Promise<ViettelDraftResult> {
    const config = getViettelSinvoiceConfig(this.configService);
    const url = new URL(
      DRAFT_ENDPOINT + encodeURIComponent(config.supplierTaxCode),
      config.baseUrl.replace(/\/*$/, '/'),
    ).toString();
    const body = await this.post(url, payload);
    if (businessErrorCode(body)) throw toBusinessError(body, null);
    return (body.result ?? {}) as ViettelDraftResult;
  }

  /**
   * Hóa đơn đã phát hành mang transactionUuid này. Nháp chưa phát hành (hoặc
   * đã xóa trên portal) không có trong kết quả.
   */
  async searchIssuedInvoices(
    transactionUuid: string,
  ): Promise<ViettelIssuedInvoice[]> {
    const config = getViettelSinvoiceConfig(this.configService);
    const url = new URL(
      SEARCH_BY_UUID_ENDPOINT,
      config.baseUrl.replace(/\/*$/, '/'),
    ).toString();
    let body: ViettelEnvelope;
    try {
      body = await this.post(
        url,
        new URLSearchParams({
          supplierTaxCode: config.supplierTaxCode,
          transactionUuid,
        }).toString(),
        'application/x-www-form-urlencoded',
      );
    } catch (error) {
      // Chưa phát hành (kể cả nháp còn trên portal): HTTP 400 NOT_FOUND_DATA.
      if (error instanceof ViettelSinvoiceError && error.code === NOT_FOUND)
        return [];
      throw error;
    }
    if (businessErrorCode(body)) throw toBusinessError(body, null);
    return Array.isArray(body.result)
      ? (body.result as ViettelIssuedInvoice[])
      : [];
  }

  private async post(
    url: string,
    data: unknown,
    contentType = 'application/json',
    retryAuth = true,
  ): Promise<ViettelEnvelope> {
    const config = getViettelSinvoiceConfig(this.configService);
    const startedAt = Date.now();
    try {
      const token = this.currentToken() ?? (await this.login());
      const response = await axios.post<ViettelEnvelope>(url, data, {
        timeout: config.timeoutMs,
        headers: {
          Accept: 'application/json',
          'Content-Type': contentType,
          Cookie: `access_token=${token}`,
        },
      });
      this.logger.log(
        `Viettel ${new URL(url).pathname} ${response.status} ${Date.now() - startedAt}ms`,
      );
      return response.data ?? {};
    } catch (error) {
      if (error instanceof ViettelSinvoiceError) throw error;
      const response = (error as AxiosError<ViettelEnvelope>).response;
      const status = response?.status ?? null;
      const tokenExpired =
        status === 401 ||
        status === 403 ||
        (status === 500 && response?.data?.message === TOKEN_EXPIRED_MESSAGE);
      if (retryAuth && tokenExpired) {
        // Gửi lại an toàn: hóa đơn nháp gắn transactionUuid nên không sinh trùng.
        this.token = null;
        return this.post(url, data, contentType, false);
      }
      throw toViettelError(error);
    }
  }

  private currentToken(): string | null {
    if (
      this.tokenExpiresAt != null &&
      Date.now() >= this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS
    ) {
      this.token = null;
    }
    return this.token;
  }

  private login(): Promise<string> {
    this.loginInFlight ??= this.performLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async performLogin(): Promise<string> {
    const config = getViettelSinvoiceConfig(this.configService);
    try {
      const response = await axios.post<{
        access_token?: unknown;
        accessToken?: unknown;
      }>(
        config.authUrl,
        { username: config.username, password: config.password },
        {
          timeout: config.timeoutMs,
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const token = response.data?.access_token ?? response.data?.accessToken;
      if (typeof token !== 'string' || !token) {
        throw new Error('missing access_token');
      }
      this.token = token;
      this.tokenExpiresAt = jwtExpiresAt(token);
      return token;
    } catch {
      // Không đưa lỗi gốc ra ngoài: request đăng nhập có chứa mật khẩu.
      throw new ViettelSinvoiceError(
        'AUTH_ERROR',
        'Không đăng nhập được Viettel S-Invoice — kiểm tra tài khoản cấu hình',
      );
    }
  }
}

/** `exp` (ms) của access_token dạng JWT; không phải JWT thì null. */
function jwtExpiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function businessErrorCode(body: ViettelEnvelope): string | null {
  const raw =
    body.errorCode != null && body.errorCode !== ''
      ? body.errorCode
      : body.code;
  if (raw == null || raw === '') return null;
  const code = String(raw).trim();
  return SUCCESS_CODES.includes(code.toUpperCase()) ? null : code;
}

function toViettelError(error: unknown): ViettelSinvoiceError {
  const axiosError = error as AxiosError<ViettelEnvelope>;
  const status = axiosError.response?.status ?? null;
  const body = axiosError.response?.data;
  if (axiosError.code === 'ECONNABORTED' || axiosError.code === 'ETIMEDOUT') {
    return new ViettelSinvoiceError(
      'TIMEOUT',
      'Viettel S-Invoice không phản hồi (quá thời gian chờ)',
    );
  }
  if (!axiosError.response) {
    return new ViettelSinvoiceError(
      'NETWORK_ERROR',
      'Không kết nối được Viettel S-Invoice',
    );
  }
  return toBusinessError(body ?? {}, status);
}

function toBusinessError(
  body: ViettelEnvelope,
  httpStatus: number | null,
): ViettelSinvoiceError {
  const symbolic =
    typeof body.message === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.message)
      ? body.message
      : null;
  const errorCode =
    body.errorCode != null && body.errorCode !== ''
      ? String(body.errorCode)
      : null;
  const code =
    errorCode ??
    symbolic ??
    (body.code != null && body.code !== '' ? String(body.code) : null) ??
    `HTTP_${httpStatus}`;
  const text =
    body.description ||
    (typeof body.data === 'string' ? body.data : null) ||
    (symbolic ? null : body.message) ||
    symbolic ||
    `Viettel S-Invoice trả lỗi${httpStatus ? ` HTTP ${httpStatus}` : ''}`;
  return new ViettelSinvoiceError(code, text, httpStatus);
}
