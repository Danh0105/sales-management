import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/role-guard';
import { Roles } from '../auth/roles.decorator';
import { TEACHER_ROLES } from '../teaching/teaching-roles';
import { ResolveZaloLocationDto } from './dto/resolve-zalo-location.dto';
import { ZaloLocationRateLimitGuard } from './zalo-location-rate-limit.guard';
import { ZaloLocationService } from './zalo-location.service';

@ApiTags('Zalo location')
@ApiBearerAuth()
@Controller('zalo/location')
@UseGuards(JwtAuthGuard, RolesGuard, ZaloLocationRateLimitGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
export class ZaloLocationController {
  constructor(private readonly service: ZaloLocationService) {}

  @Post('resolve')
  @HttpCode(200)
  @Roles(...TEACHER_ROLES)
  @ApiOperation({ summary: 'Đổi location token một lần của Zalo thành tọa độ' })
  @ApiBody({ type: ResolveZaloLocationDto })
  @ApiOkResponse({
    schema: {
      example: {
        latitude: 10.758341,
        longitude: 106.745863,
        provider: 'gps',
        timestamp: 1666249171003,
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'KIDO JWT thiếu, hết hạn hoặc không hợp lệ',
  })
  @ApiForbiddenResponse({ description: 'Chỉ role giaovien được phép gọi' })
  @ApiUnprocessableEntityResponse({
    description: 'Location token hết hạn, đã dùng hoặc bị Zalo từ chối',
  })
  @ApiBadGatewayResponse({
    description: 'Zalo lỗi, cấu hình không khớp hoặc payload sai',
  })
  @ApiGatewayTimeoutResponse({
    description: 'Zalo không phản hồi trong 5 giây',
  })
  resolve(@Body() dto: ResolveZaloLocationDto) {
    return this.service.resolve(dto.locationToken, dto.zaloAccessToken);
  }
}
