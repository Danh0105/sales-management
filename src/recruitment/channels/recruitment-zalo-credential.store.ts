import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { ZaloOutboundConfig } from './zalo-outbound.config';
import { postRequest } from './zalo-send.transport';
import { decryptToken, encryptToken } from './zalo-token.crypto';

export class ZaloCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ZaloAccessToken {
  accessToken: string;
  version: number;
  expiresAt: Date;
}

/** Refresh sớm khi access token còn dưới chừng này. */
const EXPIRY_MARGIN_MS = 60_000;

interface CredentialRow {
  access_token_enc: string;
  refresh_token_enc: string;
  access_expires_at: Date;
  version: number;
}

/**
 * Kho token OA tuyển dụng (`recruitment_zalo_credentials`) — riêng hoàn toàn với
 * `zalo_tokens` của OA giáo viên; vòng đời token hai bên độc lập.
 *
 * Refresh: transaction khoá dòng (`SELECT ... FOR UPDATE`), so `version` với bản
 * người gọi đang cầm — đã có người refresh rồi thì dùng luôn token mới, KHÔNG gọi
 * Zalo lần nữa. Nhờ vậy nhiều sender cùng gặp token hết hạn chỉ refresh một lần
 * (refresh token của Zalo chỉ dùng được một lần).
 */
@Injectable()
export class RecruitmentZaloCredentialStore {
  private readonly logger = new Logger('RecruitmentZaloCredential');

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Access token còn hạn; sắp hết hạn thì refresh trước. */
  async accessToken(config: ZaloOutboundConfig): Promise<ZaloAccessToken> {
    const rows: CredentialRow[] = await this.dataSource.query(
      `SELECT access_token_enc, refresh_token_enc, access_expires_at, version
       FROM "recruitment_zalo_credentials" WHERE oa_id = $1`,
      [config.oaId],
    );
    const row = rows[0];
    if (!row) throw new ZaloCredentialError('CREDENTIAL_MISSING');
    if (
      new Date(row.access_expires_at).getTime() - Date.now() <
      EXPIRY_MARGIN_MS
    ) {
      return this.refresh(config, Number(row.version));
    }
    return this.toToken(config, row);
  }

  /**
   * Refresh nếu token đang dùng vẫn là bản `seenVersion`; nếu đã có sender khác
   * refresh thì trả token mới của họ. Lỗi → `ZaloCredentialError`, không lộ token.
   */
  async refresh(
    config: ZaloOutboundConfig,
    seenVersion: number,
  ): Promise<ZaloAccessToken> {
    return this.dataSource.transaction(async (em) => {
      const rows: CredentialRow[] = await em.query(
        `SELECT access_token_enc, refresh_token_enc, access_expires_at, version
         FROM "recruitment_zalo_credentials" WHERE oa_id = $1 FOR UPDATE`,
        [config.oaId],
      );
      const row = rows[0];
      if (!row) throw new ZaloCredentialError('CREDENTIAL_MISSING');
      if (Number(row.version) !== seenVersion) return this.toToken(config, row);

      const refreshToken = this.decrypt(config, row.refresh_token_enc);
      const outcome = await postRequest(
        `${config.oauthUrl.replace(/\/+$/, '')}/v4/oa/access_token`,
        {
          'Content-Type': 'application/x-www-form-urlencoded',
          secret_key: config.appSecret,
        },
        new URLSearchParams({
          app_id: config.appId,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
        {
          connectTimeoutMs: config.connectTimeoutMs,
          responseTimeoutMs: config.responseTimeoutMs,
        },
      );
      if (outcome.kind === 'maybe-sent') {
        // Zalo có thể đã xoay token mà ta không nhận được — cần cấp lại thủ công.
        this.logger.error(
          `refresh outcome unknown oa=${config.oaId} code=${outcome.code} — kiểm tra/cấp lại token OA tuyển dụng`,
        );
        throw new ZaloCredentialError('REFRESH_OUTCOME_UNKNOWN');
      }
      if (outcome.kind === 'not-sent') {
        throw new ZaloCredentialError('REFRESH_NETWORK');
      }
      const tokens = parseTokens(outcome.status, outcome.body);
      if (!tokens) {
        this.logger.error(
          `refresh rejected oa=${config.oaId} http=${outcome.status} — refresh token có thể đã hỏng`,
        );
        throw new ZaloCredentialError('REFRESH_REJECTED');
      }

      const version = Number(row.version) + 1;
      await em.query(
        `UPDATE "recruitment_zalo_credentials"
         SET access_token_enc = $2, refresh_token_enc = $3,
             access_expires_at = now() + $4::int * interval '1 second',
             version = $5::int, refreshed_at = now(), updated_at = now()
         WHERE oa_id = $1`,
        [
          config.oaId,
          encryptToken(config.tokenKey, config.oaId, tokens.accessToken),
          encryptToken(config.tokenKey, config.oaId, tokens.refreshToken),
          tokens.expiresIn,
          version,
        ],
      );
      this.logger.log(`refresh ok oa=${config.oaId} version=${version}`);
      return {
        accessToken: tokens.accessToken,
        version,
        expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      };
    });
  }

  /** Nạp token ban đầu (sau khi cấp quyền OA) — ghi đè, tăng version. */
  async saveInitial(
    config: Pick<ZaloOutboundConfig, 'oaId' | 'tokenKey'>,
    tokens: { accessToken: string; refreshToken: string; expiresIn: number },
  ): Promise<number> {
    const rows: Array<{ version: number }> = await this.dataSource.query(
      `INSERT INTO "recruitment_zalo_credentials"
         (oa_id, access_token_enc, refresh_token_enc, access_expires_at)
       VALUES ($1, $2, $3, now() + $4::int * interval '1 second')
       ON CONFLICT (oa_id) DO UPDATE SET
         access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = EXCLUDED.refresh_token_enc,
         access_expires_at = EXCLUDED.access_expires_at,
         version = "recruitment_zalo_credentials".version + 1,
         updated_at = now()
       RETURNING version`,
      [
        config.oaId,
        encryptToken(config.tokenKey, config.oaId, tokens.accessToken),
        encryptToken(config.tokenKey, config.oaId, tokens.refreshToken),
        tokens.expiresIn,
      ],
    );
    return Number(rows[0]?.version);
  }

  private toToken(
    config: ZaloOutboundConfig,
    row: CredentialRow,
  ): ZaloAccessToken {
    return {
      accessToken: this.decrypt(config, row.access_token_enc),
      version: Number(row.version),
      expiresAt: new Date(row.access_expires_at),
    };
  }

  private decrypt(config: ZaloOutboundConfig, stored: string): string {
    try {
      return decryptToken(config.tokenKey, config.oaId, stored);
    } catch {
      throw new ZaloCredentialError('CREDENTIAL_UNREADABLE');
    }
  }
}

/** Response OAuth của Zalo: `{ access_token, refresh_token, expires_in }`. */
export function parseTokens(
  status: number,
  body: string,
): { accessToken: string; refreshToken: string; expiresIn: number } | null {
  if (status !== 200) return null;
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    const expiresIn = Number(data.expires_in);
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.refresh_token !== 'string' ||
      !data.refresh_token ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0
    ) {
      return null;
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn,
    };
  } catch {
    return null;
  }
}
