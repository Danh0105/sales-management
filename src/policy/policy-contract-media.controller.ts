import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { PolicyContractArchiveService } from './policy-contract-archive.service';

/**
 * Chỉ nhận request mà `express.static` ở `main.ts` không tìm thấy trên VPS —
 * tức file đã được chuyển sang NAS. Cùng mẫu với `LessonMediaController`.
 */
@ApiExcludeController()
@Controller('uploads/policy-contracts')
export class PolicyContractMediaController {
  constructor(private readonly archive: PolicyContractArchiveService) {}

  @Get(':name')
  async media(@Param('name') name: string, @Res() res: Response) {
    const found = await this.archive.locate(name);

    if (found) {
      res.setHeader('X-Policy-Contract-Tier', found.tier);
      return res.sendFile(found.path, { maxAge: '30d', immutable: true });
    }

    if (!PolicyContractArchiveService.isValidName(name)) return this.notFound(res);

    return this.archive.archiveAvailable()
      ? this.notFound(res)
      : this.unavailable(res);
  }

  private notFound(res: Response) {
    return res.status(404).json({
      statusCode: 404,
      code: 'POLICY_CONTRACT_NOT_FOUND',
      message: 'Không tìm thấy file',
    });
  }

  private unavailable(res: Response) {
    return res.status(503).json({
      statusCode: 503,
      code: 'POLICY_CONTRACT_ARCHIVE_UNAVAILABLE',
      message: 'Kho lưu trữ tạm thời mất kết nối, thử lại sau',
    });
  }
}
