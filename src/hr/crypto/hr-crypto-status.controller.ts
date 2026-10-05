import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { HrPermission } from '../access/hr-permission';
import {
  HrPermissionGuard,
  RequireHrPermission,
} from '../access/hr-permission.guard';
import { HrCryptoService } from './hr-crypto.service';
import type { HrCryptoStatus } from './hr-crypto.service';

/**
 * Trạng thái tối thiểu của tầng mã hoá HR (cho quản trị). Không bao giờ trả
 * key, fingerprint, ciphertext mẫu hay giá trị biến môi trường.
 */
@ApiTags('HR — Crypto')
@ApiBearerAuth()
@Controller('api/hr/v1/crypto')
@UseGuards(JwtAuthGuard, HrPermissionGuard)
export class HrCryptoStatusController {
  constructor(private readonly crypto: HrCryptoService) {}

  @Get('status')
  @RequireHrPermission(HrPermission.ACCESS_VIEW)
  status(): HrCryptoStatus {
    return this.crypto.status();
  }
}
