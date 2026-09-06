import { HttpException, HttpStatus } from '@nestjs/common';

export const invalidLocationToken = () =>
  new HttpException(
    {
      statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'ZALO_LOCATION_TOKEN_INVALID',
      message:
        'Vị trí đã hết hạn hoặc không còn hợp lệ. Vui lòng lấy lại vị trí.',
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );

export const locationServiceError = () =>
  new HttpException(
    {
      statusCode: HttpStatus.BAD_GATEWAY,
      code: 'ZALO_LOCATION_SERVICE_ERROR',
      message: 'Không thể xác minh vị trí với Zalo. Vui lòng thử lại.',
    },
    HttpStatus.BAD_GATEWAY,
  );

export const locationTimeout = () =>
  new HttpException(
    {
      statusCode: HttpStatus.GATEWAY_TIMEOUT,
      code: 'ZALO_LOCATION_TIMEOUT',
      message: 'Zalo không phản hồi kịp thời. Vui lòng thử lại.',
    },
    HttpStatus.GATEWAY_TIMEOUT,
  );
