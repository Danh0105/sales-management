import { ConfigService } from '@nestjs/config';

/** Tài khoản Viettel S-Invoice của công ty (bên bán) — đặt trong .env, không commit. */
export interface ViettelSinvoiceConfig {
  enabled: boolean;
  baseUrl: string;
  authUrl: string;
  username: string;
  password: string;
  supplierTaxCode: string;
  templateCode: string;
  invoiceSeries: string;
  timeoutMs: number;
}

export function getViettelSinvoiceConfig(
  config: ConfigService,
): ViettelSinvoiceConfig {
  return {
    enabled: config.get<string>('VIETTEL_SINVOICE_ENABLED') === 'true',
    baseUrl:
      config.get<string>('VIETTEL_SINVOICE_BASE_URL') ||
      'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api/',
    authUrl:
      config.get<string>('VIETTEL_SINVOICE_AUTH_URL') ||
      'https://api-vinvoice.viettel.vn/auth/login',
    username: config.get<string>('VIETTEL_SINVOICE_USERNAME') ?? '',
    password: config.get<string>('VIETTEL_SINVOICE_PASSWORD') ?? '',
    supplierTaxCode: config.get<string>('VIETTEL_SINVOICE_TAX_CODE') ?? '',
    templateCode: config.get<string>('VIETTEL_SINVOICE_TEMPLATE_CODE') ?? '',
    invoiceSeries: config.get<string>('VIETTEL_SINVOICE_SERIES') ?? '',
    timeoutMs: Number(config.get<string>('VIETTEL_SINVOICE_TIMEOUT') ?? 60000),
  };
}

/** Thiếu trường nào thì trả về tên biến môi trường tương ứng. */
export function missingViettelSettings(
  config: ViettelSinvoiceConfig,
): string[] {
  const required: Array<[keyof ViettelSinvoiceConfig, string]> = [
    ['username', 'VIETTEL_SINVOICE_USERNAME'],
    ['password', 'VIETTEL_SINVOICE_PASSWORD'],
    ['supplierTaxCode', 'VIETTEL_SINVOICE_TAX_CODE'],
    ['templateCode', 'VIETTEL_SINVOICE_TEMPLATE_CODE'],
    ['invoiceSeries', 'VIETTEL_SINVOICE_SERIES'],
  ];
  return required.filter(([key]) => !config[key]).map(([, env]) => env);
}
