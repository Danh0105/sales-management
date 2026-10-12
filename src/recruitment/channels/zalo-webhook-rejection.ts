import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';

import type { ZaloWebhookRejectCode } from './zalo-recruitment-event';

/** Mã từ chối webhook → HTTP (body chỉ có mã, không lặp lại gì từ request). */
export function rejection(code: ZaloWebhookRejectCode): HttpException {
  const body = { code };
  switch (code) {
    case 'INVALID_SIGNATURE':
      return new UnauthorizedException(body);
    case 'APP_MISMATCH':
    case 'OA_MISMATCH':
      return new ForbiddenException(body);
    case 'MALFORMED_PAYLOAD':
    case 'MALFORMED_EVENT':
      return new BadRequestException(body);
  }
}
